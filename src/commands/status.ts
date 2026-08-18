import type { AdoPullRequest } from "../ado/types.ts";
import type { GitRepo } from "../git/git.ts";
import { stackOrder } from "../stack/graph.ts";
import { restackNeeded } from "../stack/ownership.ts";
import { type PullRequestSnapshot, effectiveParent, resolveOntoSha } from "../stack/restack.ts";
import type { StackState } from "../state/schema.ts";
import { formatBranch, pullRequestWebUrl } from "../ui/format.ts";
import { createLogger } from "../ui/log.ts";
import { logNext } from "../ui/next.ts";
import { type AppContext, fromRefsHeads, requireState, resolveAdoAccess } from "./context.ts";
import { reconcileCompletedMerges } from "./reconcile.ts";
import type {
  AdoStatusAccess,
  NextStep,
  PrDisplay,
  PrState,
  StackStatus,
  StatusRow,
} from "./status-model.ts";
import {
  formatForestRows,
  parseStatusWidth,
  resolveStatusWidth,
  toStatusJson,
} from "./status-render.ts";

export type {
  AdoStatusAccess,
  ForestLine,
  NextStep,
  PrDisplay,
  PrState,
  StackStatus,
  StatusRow,
} from "./status-model.ts";
export { forestLayout, prStatusLabel, rowFlags } from "./status-model.ts";

export async function statusCommand(
  ctx: AppContext,
  flags: Record<string, string | boolean> = {},
): Promise<void> {
  const machine = flags.json === true;
  const loadCtx = machine
    ? { ...ctx, log: createLogger({ verbose: false, debug: ctx.debug, stdout: () => {} }) }
    : ctx;
  const status = await loadStackStatus(loadCtx);
  const state = await requireState(ctx);
  if (flags.json === true) {
    process.stdout.write(`${JSON.stringify(toStatusJson(status, state))}\n`);
    return;
  }
  const width = resolveStatusWidth({
    explicit: parseStatusWidth(flags.width),
    stdoutColumns: process.stdout.columns,
    columnsEnv: process.env.COLUMNS,
  });
  renderStatus(ctx, status, { width, urls: flags.urls === true, state });
}

export async function loadStackStatus(ctx: AppContext): Promise<StackStatus> {
  let state = await requireState(ctx);
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
  state = await reconcileCompletedMerges(ctx, state, { incompleteSnapshots: "skip" });
  const order = stackOrder(state);
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
  const rows: StatusRow[] = [];
  for (const branch of order) {
    const row = buildRow({
      state,
      branch,
      current,
      adoReady: access.status === "ready",
      prs,
      snapshots,
      parentTips,
    });
    const localTip = parentTips[branch] ?? state.branches[branch]?.lastLocalTip;
    const remoteTip = state.branches[branch]?.lastKnownRemoteTip;
    const counts = await divergenceCounts(ctx.git, localTip, remoteTip);
    rows.push({ ...row, ahead: counts.ahead, behind: counts.behind });
  }
  const ado: AdoStatusAccess =
    access.status === "ready"
      ? loadError !== undefined
        ? { kind: "ready", loadError }
        : { kind: "ready" }
      : { kind: "unavailable", reason: access.reason, message: access.message };
  return {
    rows,
    currentBranch: current,
    defaultBranch: state.defaultBranch,
    ado,
    issues: collectIssues(state, order, ado, prs, ctx.config.branchPrefix),
    next: nextStep(ado, rows),
  };
}

function nextStep(ado: AdoStatusAccess, rows: StatusRow[]): NextStep {
  if (ado.kind === "unavailable" && ado.reason === "unauthenticated") {
    return "auth-login";
  }
  if (rows.length === 0) {
    return "create";
  }
  if (rows.some((row) => row.needsRestack)) {
    return "restack";
  }
  if (rows.some((row) => row.pr.kind === "none")) {
    return "submit";
  }
  return "none";
}

function renderStatus(
  ctx: AppContext,
  status: StackStatus,
  options: { width: number; urls: boolean; state: StackState },
): void {
  const prefix = ctx.config.branchPrefix;
  if (status.ado.kind === "unavailable") {
    ctx.log.info(
      status.ado.reason === "unauthenticated"
        ? "Not authenticated to Azure DevOps."
        : `Azure DevOps status unavailable: ${status.ado.message}`,
    );
  } else if (status.ado.loadError !== undefined) {
    ctx.log.warn(`Azure DevOps status is incomplete: ${status.ado.loadError}`);
  }
  ctx.log.info("Stack");
  ctx.log.info("");
  ctx.log.info(`  ${formatBranch(status.defaultBranch, prefix)}`);
  if (status.rows.length === 0) {
    ctx.log.info("  (empty)");
  }
  for (const line of formatForestRows(status, {
    width: options.width,
    urls: options.urls,
    branchPrefix: prefix,
    state: options.state,
  })) {
    ctx.log.info(line);
  }
  ctx.log.info("");
  ctx.log.info(`Current: ${formatBranch(status.currentBranch, prefix)}`);
  if (status.issues.length > 0) {
    ctx.log.info("");
    ctx.log.info("Notes");
    for (const issue of status.issues) {
      ctx.log.info(`  ${issue}`);
    }
  }
  ctx.log.info("");
  switch (status.next) {
    case "auth-login":
      logNext(ctx.log, "ado-stack auth login");
      return;
    case "create":
      logNext(ctx.log, "ado-stack create <name>");
      return;
    case "submit":
      logNext(ctx.log, "ado-stack submit");
      return;
    case "restack":
      logNext(ctx.log, "ado-stack restack");
      return;
    case "none":
      return;
    default: {
      const _exhaustive: never = status.next;
      throw new Error(`Unhandled next step ${String(_exhaustive)}`);
    }
  }
}

async function divergenceCounts(
  git: GitRepo,
  localTip: string | undefined,
  remoteTip: string | undefined,
): Promise<{ ahead: number; behind: number }> {
  if (!localTip || !remoteTip || localTip === remoteTip) {
    return { ahead: 0, behind: 0 };
  }
  try {
    const [aheadCommits, behindCommits] = await Promise.all([
      git.getCommitsBetween(remoteTip, localTip),
      git.getCommitsBetween(localTip, remoteTip),
    ]);
    return { ahead: aheadCommits.length, behind: behindCommits.length };
  } catch {
    return { ahead: 0, behind: 0 };
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

function buildRow(options: {
  state: StackState;
  branch: string;
  current: string;
  adoReady: boolean;
  prs: Map<number, AdoPullRequest>;
  snapshots: Map<number, PullRequestSnapshot>;
  parentTips: Record<string, string>;
}): StatusRow {
  const record = options.state.branches[options.branch];
  if (!record) {
    throw new Error(`Stack order returned untracked branch ${options.branch}`);
  }
  const pr = record.pullRequestId !== undefined ? options.prs.get(record.pullRequestId) : undefined;
  const display: PrDisplay = pr
    ? {
        kind: "loaded",
        id: pr.pullRequestId,
        title: pr.title,
        url: pullRequestWebUrl(options.state, pr.pullRequestId),
        state: prState(pr),
      }
    : record.pullRequestId === undefined
      ? { kind: "none" }
      : { kind: "unknown", id: record.pullRequestId };
  const resolved = effectiveParent({
    state: options.state,
    branch: options.branch,
    pullRequests: options.snapshots,
  });
  const parentTip = options.parentTips[resolved.parent] ?? record.lastRestackBase;
  const needsRestack =
    restackNeeded({
      lastRestackBase: record.lastRestackBase,
      parentTip,
      parentCompleted: resolved.parentCompleted,
    }) ||
    (pr !== undefined && fromRefsHeads(pr.targetRefName) !== record.parent);
  const localTip = options.parentTips[options.branch] ?? record.lastLocalTip;
  const diverged = Boolean(
    record.lastKnownRemoteTip && localTip && record.lastKnownRemoteTip !== localTip,
  );
  return {
    branch: options.branch,
    parent: record.parent,
    pr: display,
    isCurrent: options.branch === options.current,
    needsRestack,
    diverged,
    ahead: 0,
    behind: 0,
  };
}

function prState(pr: AdoPullRequest): PrState {
  if (pr.status === "completed") {
    return "completed";
  }
  if (pr.status === "abandoned") {
    return "abandoned";
  }
  const votes = (pr.reviewers ?? []).map((reviewer) => reviewer.vote ?? 0);
  if (votes.some((vote) => vote <= -10)) {
    return "rejected";
  }
  if (votes.some((vote) => vote >= 10)) {
    return "approved";
  }
  return "open";
}

function collectIssues(
  state: StackState,
  order: string[],
  ado: AdoStatusAccess,
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
    if (ado.kind === "ready" && record.pullRequestId !== undefined && !pr) {
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
