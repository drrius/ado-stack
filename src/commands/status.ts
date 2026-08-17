import type { AdoPullRequest } from "../ado/types.ts";
import { stackOrder } from "../stack/graph.ts";
import { displayName } from "../stack/names.ts";
import { restackNeeded } from "../stack/ownership.ts";
import { type PullRequestSnapshot, effectiveParent } from "../stack/restack.ts";
import type { StackState } from "../state/schema.ts";
import { type AppContext, fromRefsHeads, maybeAdoClient, requireState } from "./context.ts";

export async function statusCommand(ctx: AppContext): Promise<void> {
  const state = await requireState(ctx);
  const order = stackOrder(state);
  const current = (await ctx.git.currentBranch()) ?? "HEAD";
  const ado = await maybeAdoClient(ctx, state);
  const prs = new Map<number, AdoPullRequest>();
  if (ado) {
    try {
      await ctx.git.fetch(state.remoteName);
      for (const branch of order) {
        const id = state.branches[branch]?.pullRequestId;
        if (id === undefined) {
          continue;
        }
        try {
          prs.set(id, await ado.getPullRequest(id));
        } catch {
          ctx.log.debug(`Could not load PR #${id}`);
        }
      }
    } catch (error) {
      ctx.log.warn(
        `Azure DevOps status is incomplete: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const parentTips: Record<string, string> = {};
  const names = [state.defaultBranch, ...order];
  for (const name of names) {
    try {
      parentTips[name] = await ctx.git.getBranchTip(name);
    } catch {
      ctx.log.debug(`No local tip for ${name}`);
    }
  }

  const snapshots = toSnapshots(prs);
  ctx.log.info("Stack");
  ctx.log.info("");
  if (order.length === 0) {
    ctx.log.info("  (empty)");
  }
  for (const branch of [...order].reverse()) {
    ctx.log.info(formatRow({ ctx, state, branch, current, prs, snapshots, parentTips }));
  }
  ctx.log.info("");
  ctx.log.info(`Current: ${current}`);
  const issues = collectIssues(state, order, prs);
  if (issues.length > 0) {
    ctx.log.info("");
    ctx.log.info("Notes");
    for (const issue of issues) {
      ctx.log.info(`  ${issue}`);
    }
  }
}

function toSnapshots(prs: Map<number, AdoPullRequest>): Map<number, PullRequestSnapshot> {
  const snapshots = new Map<number, PullRequestSnapshot>();
  for (const [id, pr] of prs) {
    snapshots.set(id, {
      id,
      status: pr.status,
      sourceBranch: fromRefsHeads(pr.sourceRefName),
      targetBranch: fromRefsHeads(pr.targetRefName),
    });
  }
  return snapshots;
}

function formatRow(options: {
  ctx: AppContext;
  state: StackState;
  branch: string;
  current: string;
  prs: Map<number, AdoPullRequest>;
  snapshots: Map<number, PullRequestSnapshot>;
  parentTips: Record<string, string>;
}): string {
  const record = options.state.branches[options.branch];
  if (!record) {
    return `  ${options.branch}`;
  }
  const pr = record.pullRequestId !== undefined ? options.prs.get(record.pullRequestId) : undefined;
  const prLabel = record.pullRequestId !== undefined ? `#${record.pullRequestId}` : "no-pr";
  const name = displayName(options.branch, options.ctx.config.branchPrefix).padEnd(12);
  const parent = displayName(record.parent, options.ctx.config.branchPrefix).padEnd(10);
  const status = (pr ? prStatusLabel(pr) : "LOCAL").padEnd(10);
  const flags: string[] = [];
  if (options.branch === options.current) {
    flags.push("current");
  }
  const resolved = effectiveParent({
    state: options.state,
    branch: options.branch,
    pullRequests: options.snapshots,
  });
  const parentTip = options.parentTips[resolved.parent] ?? record.lastRestackBase;
  const needs =
    restackNeeded({
      lastRestackBase: record.lastRestackBase,
      parentTip,
      parentCompleted: resolved.parentCompleted,
    }) ||
    (pr !== undefined && fromRefsHeads(pr.targetRefName) !== record.parent);
  if (needs) {
    flags.push("↑ restack needed");
  } else if (pr) {
    flags.push("✓ synced");
  }
  if (
    record.lastKnownRemoteTip &&
    record.lastLocalTip &&
    record.lastKnownRemoteTip !== record.lastLocalTip
  ) {
    flags.push("local/remote diverge");
  }
  return `  ${prLabel.padEnd(6)} ${name} → ${parent} ${status} ${flags.join("  ")}`.trimEnd();
}

function prStatusLabel(pr: AdoPullRequest): string {
  if (pr.status === "completed") {
    return "COMPLETED";
  }
  if (pr.status === "abandoned") {
    return "ABANDONED";
  }
  const votes = (pr.reviewers ?? []).map((reviewer) => reviewer.vote ?? 0);
  if (votes.some((vote) => vote <= -10)) {
    return "REJECTED";
  }
  if (votes.some((vote) => vote >= 10)) {
    return "APPROVED";
  }
  return "OPEN";
}

function collectIssues(
  state: StackState,
  order: string[],
  prs: Map<number, AdoPullRequest>,
): string[] {
  const issues: string[] = [];
  for (const branch of order) {
    const record = state.branches[branch];
    if (!record) {
      continue;
    }
    const pr = record.pullRequestId !== undefined ? prs.get(record.pullRequestId) : undefined;
    if (record.pullRequestId !== undefined && !pr) {
      issues.push(`PR #${record.pullRequestId} for ${branch} could not be loaded.`);
    }
    if (pr && fromRefsHeads(pr.sourceRefName) !== branch) {
      issues.push(
        `PR #${pr.pullRequestId} source is ${fromRefsHeads(pr.sourceRefName)}, expected ${branch}.`,
      );
    }
  }
  return issues;
}
