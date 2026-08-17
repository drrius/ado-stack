import type { AdoPullRequest } from "../ado/types.ts";
import { stackOrder } from "../stack/graph.ts";
import { restackNeeded } from "../stack/ownership.ts";
import { type PullRequestSnapshot, effectiveParent, resolveOntoSha } from "../stack/restack.ts";
import type { StackState } from "../state/schema.ts";
import { formatBranch, pullRequestWebUrl } from "../ui/format.ts";
import { logNext } from "../ui/next.ts";
import {
  type AdoAccess,
  type AppContext,
  fromRefsHeads,
  requireState,
  resolveAdoAccess,
} from "./context.ts";

export async function statusCommand(ctx: AppContext): Promise<void> {
  const state = await requireState(ctx);
  const order = stackOrder(state);
  const current = (await ctx.git.currentBranch()) ?? "HEAD";
  const access = await resolveAdoAccess(ctx, state);
  const prs = new Map<number, AdoPullRequest>();
  let loadError: string | undefined;
  try {
    await ctx.git.fetch(state.remoteName);
  } catch (error) {
    ctx.log.debug(
      `Could not fetch ${state.remoteName}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (access.status === "ready") {
    for (const branch of order) {
      const id = state.branches[branch]?.pullRequestId;
      if (id === undefined) {
        continue;
      }
      try {
        prs.set(id, await access.client.getPullRequest(id));
      } catch (error) {
        loadError ??= error instanceof Error ? error.message : String(error);
        ctx.log.debug(`Could not load PR #${id}`);
      }
    }
  }

  const parentTips: Record<string, string> = {};
  const names = [state.defaultBranch, ...order];
  for (const name of names) {
    try {
      parentTips[name] = await resolveOntoSha(ctx.git, state, name);
    } catch {
      ctx.log.debug(`No local tip for ${name}`);
    }
  }

  const snapshots = toSnapshots(prs);
  if (access.status === "unavailable") {
    ctx.log.info(
      access.reason === "unauthenticated"
        ? "Not authenticated to Azure DevOps."
        : `Azure DevOps status unavailable: ${access.message}`,
    );
  } else if (loadError) {
    ctx.log.warn(`Azure DevOps status is incomplete: ${loadError}`);
  }
  ctx.log.info("Stack");
  ctx.log.info("");
  if (order.length === 0) {
    ctx.log.info("  (empty)");
  }
  const rows = order.map((branch) =>
    formatRow({ ctx, state, branch, current, access, prs, snapshots, parentTips }),
  );
  for (const row of rows) {
    ctx.log.info(row.line);
    if (row.url) {
      ctx.log.info(`    ${row.url}`);
    }
  }
  ctx.log.info("");
  ctx.log.info(`Current: ${formatBranch(current, ctx.config.branchPrefix)}`);
  const issues = collectIssues(state, order, access, prs, ctx.config.branchPrefix);
  if (issues.length > 0) {
    ctx.log.info("");
    ctx.log.info("Notes");
    for (const issue of issues) {
      ctx.log.info(`  ${issue}`);
    }
  }
  ctx.log.info("");
  if (access.status === "unavailable" && access.reason === "unauthenticated") {
    logNext(ctx.log, "ado-stack auth login");
  } else if (order.length === 0) {
    logNext(ctx.log, "ado-stack create <name>");
  } else if (rows.some((row) => row.needsRestack)) {
    logNext(ctx.log, "ado-stack restack");
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
  access: AdoAccess;
  prs: Map<number, AdoPullRequest>;
  snapshots: Map<number, PullRequestSnapshot>;
  parentTips: Record<string, string>;
}): { line: string; url?: string; needsRestack: boolean } {
  const record = options.state.branches[options.branch];
  if (!record) {
    return {
      line: `  ${formatBranch(options.branch, options.ctx.config.branchPrefix)}`,
      needsRestack: false,
    };
  }
  const pr = record.pullRequestId !== undefined ? options.prs.get(record.pullRequestId) : undefined;
  const prLabel = record.pullRequestId !== undefined ? `#${record.pullRequestId}` : "no-pr";
  const name = formatBranch(options.branch, options.ctx.config.branchPrefix).padEnd(12);
  const parent = formatBranch(record.parent, options.ctx.config.branchPrefix).padEnd(10);
  const status = (
    pr
      ? prStatusLabel(pr)
      : record.pullRequestId !== undefined && options.access.status === "unavailable"
        ? "UNKNOWN"
        : "LOCAL"
  ).padEnd(10);
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
  const localTip = options.parentTips[options.branch] ?? record.lastLocalTip;
  if (record.lastKnownRemoteTip && localTip && record.lastKnownRemoteTip !== localTip) {
    flags.push("local/remote diverge");
  }
  const title = pr?.title ? `  ${pr.title}` : "";
  const row: { line: string; url?: string; needsRestack: boolean } = {
    line: `  ${prLabel.padEnd(6)} ${name} → ${parent} ${status} ${flags.join("  ")}${title}`.trimEnd(),
    needsRestack: needs,
  };
  if (pr) {
    row.url = pullRequestWebUrl(options.state, pr.pullRequestId);
  }
  return row;
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
  access: AdoAccess,
  prs: Map<number, AdoPullRequest>,
  prefix: string,
): string[] {
  const issues: string[] = [];
  for (const branch of order) {
    const record = state.branches[branch];
    if (!record) {
      continue;
    }
    const pr = record.pullRequestId !== undefined ? prs.get(record.pullRequestId) : undefined;
    if (access.status === "ready" && record.pullRequestId !== undefined && !pr) {
      issues.push(
        `PR #${record.pullRequestId} for ${formatBranch(branch, prefix)} could not be loaded.`,
      );
    }
    if (pr && fromRefsHeads(pr.sourceRefName) !== branch) {
      issues.push(
        `PR #${pr.pullRequestId} source is ${formatBranch(fromRefsHeads(pr.sourceRefName), prefix)}, expected ${formatBranch(branch, prefix)}.`,
      );
    }
  }
  return issues;
}
