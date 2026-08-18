import type { AdoClient } from "../ado/client.ts";
import {
  type GitReconcileFacts,
  type LocalBranchDisposition,
  type MergeAbsorption,
  type MergeChild,
  applyAbsorption,
  planCompletedMerges,
} from "../stack/reconcile.ts";
import { type PullRequestSnapshot, resolveOntoSha } from "../stack/restack.ts";
import { heldBranchesOutsideCurrent } from "../stack/worktrees.ts";
import type { StackState } from "../state/schema.ts";
import { formatBranch } from "../ui/format.ts";
import { type AppContext, resolveAdoAccess } from "./context.ts";
import { loadTrackedSnapshots, retargetStackPullRequest } from "./pull-requests.ts";

export async function reconcileCompletedMerges(
  ctx: AppContext,
  state: StackState,
): Promise<StackState> {
  if (await ctx.stateStore.readRestackPlan()) {
    ctx.log.info("Skipped merge reconcile because a restack is in progress.");
    return state;
  }
  const access = await resolveAdoAccess(ctx, state);
  if (access.status === "unavailable") {
    ctx.log.info(`Skipped merge reconcile: ${access.message}`);
    return state;
  }
  const pullRequests = await loadTrackedSnapshots(access.client, state);
  const facts = await collectGitFacts(ctx, state);
  const plan = planCompletedMerges({ state, pullRequests, facts });
  if (plan.absorptions.length === 0) {
    return state;
  }
  let current = state;
  for (const absorption of plan.absorptions) {
    current = await applyPlannedAbsorption(ctx, access.client, current, absorption, pullRequests);
  }
  return current;
}

async function applyPlannedAbsorption(
  ctx: AppContext,
  ado: AdoClient,
  state: StackState,
  absorption: MergeAbsorption,
  pullRequests: Map<number, PullRequestSnapshot>,
): Promise<StackState> {
  const prefix = ctx.config.branchPrefix;
  const intoLabel = formatBranch(absorption.into, prefix);
  const branchLabel = formatBranch(absorption.branch, prefix);
  ctx.log.success(
    `Merged PR #${absorption.pullRequestId} \`${branchLabel}\` into \`${intoLabel}\``,
  );
  const retargeted: MergeChild[] = [];
  for (const child of absorption.children) {
    if (child.pullRequestId === undefined) {
      continue;
    }
    if (pullRequests.get(child.pullRequestId)?.status !== "active") {
      continue;
    }
    const didRetarget = await retargetStackPullRequest({
      ado,
      state,
      branch: child.branch,
      pullRequestId: child.pullRequestId,
      target: absorption.into,
    });
    if (didRetarget) {
      retargeted.push(child);
    }
  }
  for (const child of absorption.children) {
    const childLabel = formatBranch(child.branch, prefix);
    if (child.pullRequestId === undefined) {
      ctx.log.success(`Reparented \`${childLabel}\` → \`${intoLabel}\``);
      continue;
    }
    ctx.log.success(`Reparented PR #${child.pullRequestId} \`${childLabel}\` → \`${intoLabel}\``);
  }
  for (const child of retargeted) {
    if (child.pullRequestId === undefined) {
      continue;
    }
    ctx.log.success(
      `Retargeted PR #${child.pullRequestId} \`${formatBranch(child.branch, prefix)}\` → \`${intoLabel}\``,
    );
  }
  const next = applyAbsorption(state, absorption);
  await ctx.stateStore.write(next);
  switch (absorption.local.kind) {
    case "delete":
      await ctx.git.deleteLocalBranch(absorption.branch);
      ctx.log.success(`Deleted local branch \`${branchLabel}\` (contained in \`${intoLabel}\`)`);
      break;
    case "keep":
      ctx.log.success(
        `Kept local branch \`${branchLabel}\` (${keepReasonText(absorption.local, intoLabel)})`,
      );
      break;
    default: {
      const _exhaustive: never = absorption.local;
      throw new Error(`Unhandled local disposition ${String(_exhaustive)}`);
    }
  }
  return next;
}

function keepReasonText(
  local: Extract<LocalBranchDisposition, { kind: "keep" }>,
  intoLabel: string,
): string {
  switch (local.reason) {
    case "not-contained":
      return `not contained in \`${intoLabel}\``;
    case "missing":
      return "missing";
    case "checked-out":
      return "checked out";
    case "held-by-worktree":
      return "held by another worktree";
    default: {
      const _exhaustive: never = local.reason;
      throw new Error(`Unhandled keep reason ${String(_exhaustive)}`);
    }
  }
}

async function collectGitFacts(ctx: AppContext, state: StackState): Promise<GitReconcileFacts> {
  const currentBranch = await ctx.git.currentBranch();
  const currentPath = await ctx.git.toplevel();
  const heldBranches = new Set(
    heldBranchesOutsideCurrent({
      currentPath,
      worktrees: await ctx.git.listWorktrees(),
      branches: Object.keys(state.branches),
    }).map((hold) => hold.branch),
  );
  const existing = new Set<string>();
  for (const branch of Object.keys(state.branches)) {
    if (await ctx.git.branchExists(branch)) {
      existing.add(branch);
    }
  }
  const contained = new Map<string, boolean>();
  const intoNames = [state.defaultBranch, ...Object.keys(state.branches)];
  for (const branch of existing) {
    for (const into of intoNames) {
      contained.set(`${branch}\n${into}`, await branchContainedIn(ctx, state, branch, into));
    }
  }
  return {
    currentBranch,
    heldBranches,
    branchExists: (branch) => existing.has(branch),
    containedIn: (branch, into) => contained.get(`${branch}\n${into}`) === true,
  };
}

async function branchContainedIn(
  ctx: AppContext,
  state: StackState,
  branch: string,
  into: string,
): Promise<boolean> {
  try {
    const branchTip = await ctx.git.getBranchTip(branch);
    const intoTip = await resolveOntoSha(ctx.git, state, into);
    return ctx.git.isAncestor(branchTip, intoTip);
  } catch {
    return false;
  }
}
