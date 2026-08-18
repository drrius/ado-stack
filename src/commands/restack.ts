import { targetBranchGoneMessage } from "../ado/errors.ts";
import {
  decodeStackProperties,
  encodeStackProperties,
  propertyPatches,
} from "../ado/properties.ts";
import { CliError } from "../errors/cli-error.ts";
import { GitRepo } from "../git/git.ts";
import { sameWorktreePath } from "../git/worktree.ts";
import { stackOrder } from "../stack/graph.ts";
import {
  type PullRequestSnapshot,
  RestackConflictError,
  applyRestackStepToState,
  assertSafeRewrite,
  branchWasSubmitted,
  conflictScope,
  executeRestackStep,
  markStep,
  planRestack,
  resolveOntoSha,
} from "../stack/restack.ts";
import { resolveRestackWorktrees, restackRebaseGit } from "../stack/worktrees.ts";
import type { RestackPlanState, RestackStep, StackState } from "../state/schema.ts";
import { formatBranch } from "../ui/format.ts";
import {
  type AppContext,
  fromRefsHeads,
  refsHeads,
  requireState,
  resolveAdoAccess,
} from "./context.ts";

export async function previewRestack(ctx: AppContext): Promise<RestackPlanState> {
  const state = await requireState(ctx);
  await ctx.git.fetch(state.remoteName);
  const pullRequests = await loadSnapshots(ctx, state);
  return planRestack({ git: ctx.git, state, pullRequests });
}

export async function restackCommand(
  ctx: AppContext,
  flags: Record<string, string | boolean>,
): Promise<void> {
  if (flags.abort === true) {
    await abortRestack(ctx);
    return;
  }
  if (flags.continue === true) {
    await continueRestack(ctx);
    return;
  }
  const state = await requireState(ctx);
  await ctx.git.requireCleanTrackedTree("restack");
  if (await ctx.git.rebaseInProgress()) {
    throw new CliError(
      "A Git rebase is already in progress.\n\nFinish it with `git rebase --continue` or `ado-stack restack --abort`.",
    );
  }
  await ctx.git.fetch(state.remoteName);
  const pullRequests = await loadSnapshots(ctx, state);
  const plan = await planRestack({ git: ctx.git, state, pullRequests });
  if (plan.steps.length === 0) {
    ctx.log.info("Stack is already up to date.");
    return;
  }
  await resolveRestackWorktrees(
    ctx.git,
    plan.steps.map((step) => step.branch),
  );
  await ctx.stateStore.writeRestackPlan(plan);
  await restoreCheckoutAfter(ctx.git, () => runPlan(ctx, state, plan));
}

async function continueRestack(ctx: AppContext): Promise<void> {
  const plan = await ctx.stateStore.readRestackPlan();
  if (!plan) {
    throw new CliError("No restack is in progress.");
  }
  const rebaseGit =
    (await restackRebaseGit(
      ctx.git,
      plan.steps.filter((step) => step.status !== "done").map((step) => step.branch),
    )) ?? ctx.git;
  if (await rebaseGit.rebaseInProgress()) {
    const where = sameWorktreePath(rebaseGit.cwd, ctx.git.cwd)
      ? ""
      : `\n\nThe rebase is in the worktree at:\n  ${rebaseGit.cwd}`;
    throw new CliError(
      `Git rebase is still in progress.${where}\n\nResolve conflicts, \`git add\` the files, run \`git rebase --continue\`, then \`ado-stack restack --continue\`.`,
    );
  }
  const state = await requireState(ctx);
  const conflicted = plan.steps.find(
    (step) => step.status === "conflict" || step.status === "in-progress",
  );
  if (conflicted) {
    const tip = await ctx.git.getBranchTip(conflicted.branch);
    if (tip === conflicted.preRebaseTip) {
      throw new CliError(
        `Rebase of \`${conflicted.branch}\` did not complete. The branch tip is unchanged.\n\nFinish the rebase or run \`ado-stack restack --abort\`.`,
      );
    }
    const nextState = applyRestackStepToState(state, conflicted, tip);
    await pushRewritten(ctx, nextState, conflicted);
    await retargetIfNeeded(ctx, nextState, conflicted);
    await ctx.stateStore.write(nextState);
    const nextPlan = markStep(plan, conflicted.branch, "done");
    await ctx.stateStore.writeRestackPlan(nextPlan);
    await restoreCheckoutAfter(ctx.git, () => runPlan(ctx, nextState, nextPlan));
    return;
  }
  await restoreCheckoutAfter(ctx.git, () => runPlan(ctx, state, plan));
}

async function abortRestack(ctx: AppContext): Promise<void> {
  const plan = await ctx.stateStore.readRestackPlan();
  const branches = plan
    ? plan.steps.filter((step) => step.status !== "done").map((step) => step.branch)
    : [];
  const rebaseGit = (await restackRebaseGit(ctx.git, branches)) ?? ctx.git;
  if (await rebaseGit.rebaseInProgress()) {
    await rebaseGit.abortRebase();
    ctx.log.info("Aborted the in-progress Git rebase.");
  }
  await ctx.stateStore.clearRestackPlan();
  ctx.log.info("Cleared the ado-stack restack plan. Branches already pushed were not rolled back.");
}

type CheckoutSnapshot = {
  branch: string | undefined;
  head: string;
};

async function snapshotCheckout(git: AppContext["git"]): Promise<CheckoutSnapshot> {
  return {
    branch: await git.currentBranch(),
    head: await git.getBranchTip("HEAD"),
  };
}

async function restoreCheckout(git: AppContext["git"], start: CheckoutSnapshot): Promise<void> {
  if (await git.rebaseInProgress()) {
    return;
  }
  const branch = await git.currentBranch();
  if (start.branch !== undefined) {
    if (branch !== start.branch) {
      await git.checkout(start.branch);
    }
    return;
  }
  const head = await git.getBranchTip("HEAD");
  if (head !== start.head) {
    await git.run(["checkout", "--detach", start.head]);
  }
}

async function restoreCheckoutAfter(
  git: AppContext["git"],
  action: () => Promise<void>,
): Promise<void> {
  const start = await snapshotCheckout(git);
  try {
    await action();
  } catch (error) {
    await restoreCheckout(git, start);
    throw error;
  }
  await restoreCheckout(git, start);
}

async function runPlan(
  ctx: AppContext,
  state: StackState,
  initialPlan: RestackPlanState,
): Promise<void> {
  const pending = initialPlan.steps
    .filter((step) => step.status !== "done")
    .map((step) => step.branch);
  const sites = await resolveRestackWorktrees(ctx.git, pending);
  const currentPath = await ctx.git.toplevel();
  let current = state;
  let plan = initialPlan;
  for (const step of plan.steps) {
    if (step.status === "done") {
      continue;
    }
    const live: RestackStep = {
      ...step,
      ontoSha: await resolveOntoSha(ctx.git, current, step.onto),
      preRebaseTip: await ctx.git.getBranchTip(step.branch),
      oldBase: current.branches[step.branch]?.lastRestackBase ?? step.oldBase,
    };
    plan = {
      ...plan,
      steps: plan.steps.map((item) =>
        item.branch === live.branch ? { ...live, status: "in-progress" } : item,
      ),
    };
    await ctx.stateStore.writeRestackPlan(plan);
    const site = sites.get(live.branch) ?? currentPath;
    const rebaseGit = sameWorktreePath(site, currentPath) ? ctx.git : new GitRepo(site);
    try {
      current = await executeRestackStep({
        git: ctx.git,
        state: current,
        step: live,
        rebaseGit,
      });
    } catch (error) {
      if (error instanceof RestackConflictError) {
        await ctx.stateStore.writeRestackPlan(markStep(plan, step.branch, "conflict"));
        const scope = conflictScope(current, plan, step.branch);
        throw new RestackConflictError(error.branch, error, {
          ...scope,
          worktreePath: error.worktreePath,
        });
      }
      throw error;
    }
    await pushRewritten(ctx, current, live);
    await retargetIfNeeded(ctx, current, live);
    await ctx.stateStore.write(current);
    plan = markStep(plan, step.branch, "done");
    await ctx.stateStore.writeRestackPlan(plan);
    ctx.log.success(
      `Restacked ${formatBranch(step.branch, ctx.config.branchPrefix)} onto ${formatBranch(step.onto, ctx.config.branchPrefix)}`,
    );
  }
  await ctx.stateStore.clearRestackPlan();
  ctx.log.info(
    `Stack restacked: ${stackOrder(current)
      .map((branch) => formatBranch(branch, ctx.config.branchPrefix))
      .join(", ")}`,
  );
}

async function pushRewritten(ctx: AppContext, state: StackState, step: RestackStep): Promise<void> {
  const record = state.branches[step.branch];
  if (!record || !branchWasSubmitted(record)) {
    return;
  }
  await assertSafeRewrite({
    git: ctx.git,
    state,
    branch: step.branch,
    remoteName: state.remoteName,
  });
  const exists = await ctx.git.remoteBranchExists(state.remoteName, step.branch);
  if (!exists) {
    await ctx.git.push(state.remoteName, step.branch, { setUpstream: true });
  } else {
    const expected = record.lastKnownRemoteTip ?? step.preRebaseTip;
    await ctx.git.forcePushWithLease({
      remote: state.remoteName,
      branch: step.branch,
      expectedRemoteSha: expected,
    });
  }
  const tip = await ctx.git.getBranchTip(step.branch);
  record.lastKnownRemoteTip = tip;
  record.lastLocalTip = tip;
}

async function retargetIfNeeded(
  ctx: AppContext,
  state: StackState,
  step: RestackStep,
): Promise<void> {
  if (!step.retargetPrTo) {
    return;
  }
  const record = state.branches[step.branch];
  if (!record?.pullRequestId) {
    return;
  }
  const access = await resolveAdoAccess(ctx, state);
  if (access.status === "unavailable") {
    throw new CliError(
      `${access.message}\n\nAzure DevOps access is required to retarget pull requests safely during restack.`,
    );
  }
  const ado = access.client;
  const pr = await ado.getPullRequest(record.pullRequestId);
  if (pr.status !== "active") {
    throw new CliError(
      `Cannot retarget PR #${pr.pullRequestId} because it is ${pr.status}. Expected an active PR from \`${step.branch}\`.`,
    );
  }
  if (fromRefsHeads(pr.sourceRefName) !== step.branch) {
    throw new CliError(
      `Cannot retarget PR #${pr.pullRequestId}: source is ${fromRefsHeads(pr.sourceRefName)}, expected ${step.branch}.`,
    );
  }
  if (fromRefsHeads(pr.targetRefName) === step.retargetPrTo) {
    return;
  }
  try {
    await ado.updatePullRequest(pr.pullRequestId, { targetRefName: refsHeads(step.retargetPrTo) });
  } catch (error) {
    throw new CliError(targetBranchGoneMessage(step.retargetPrTo), { cause: error });
  }
  const previous = await ado.getPullRequestProperties(pr.pullRequestId);
  const existing = decodeStackProperties(previous);
  const stackId = state.stackId ?? existing?.stackId;
  if (stackId) {
    await ado.updatePullRequestProperties(
      pr.pullRequestId,
      propertyPatches(
        encodeStackProperties({
          version: existing?.version ?? "1",
          stackId,
          parent: step.retargetPrTo,
          branch: step.branch,
          lastRestackBase: record.lastRestackBase,
        }),
        previous,
      ),
    );
  }
  ctx.log.success(
    `PR #${pr.pullRequestId} ${formatBranch(step.branch, ctx.config.branchPrefix)} → ${formatBranch(step.retargetPrTo, ctx.config.branchPrefix)}`,
  );
}

async function loadSnapshots(
  ctx: AppContext,
  state: StackState,
): Promise<Map<number, PullRequestSnapshot>> {
  const snapshots = new Map<number, PullRequestSnapshot>();
  const branches = stackOrder(state);
  const pullRequestIds = branches.flatMap((branch) => {
    const id = state.branches[branch]?.pullRequestId;
    return id === undefined ? [] : [id];
  });
  const access = await resolveAdoAccess(ctx, state);
  if (access.status === "unavailable") {
    if (pullRequestIds.length === 0) {
      ctx.log.debug(`${access.message} Restack has no pull request state to resolve.`);
      return snapshots;
    }
    ctx.log.warn(access.message);
    throw new CliError(
      "Azure DevOps authentication is required to restack safely after merges.\n\nRun `ado-stack auth login`, then retry `ado-stack restack`.",
    );
  }
  const ado = access.client;
  for (const branch of branches) {
    const id = state.branches[branch]?.pullRequestId;
    if (id === undefined) {
      continue;
    }
    try {
      const pr = await ado.getPullRequest(id);
      snapshots.set(id, {
        id,
        status: pr.status,
        sourceBranch: fromRefsHeads(pr.sourceRefName),
        targetBranch: fromRefsHeads(pr.targetRefName),
      });
    } catch (error) {
      throw new CliError(
        `Could not load PR #${id} from Azure DevOps.\n\nRestack requires complete pull request state to handle merged parents safely.`,
        { cause: error },
      );
    }
  }
  return snapshots;
}
