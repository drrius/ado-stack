import type { AdoPullRequest } from "../ado/types.ts";
import { stackOrder } from "../stack/graph.ts";
import { restackNeeded } from "../stack/ownership.ts";
import { type PullRequestSnapshot, effectiveParent, resolveOntoSha } from "../stack/restack.ts";
import type { StackState } from "../state/schema.ts";
import { formatBranch, pullRequestWebUrl } from "../ui/format.ts";
import { logNext } from "../ui/next.ts";
import { type AppContext, fromRefsHeads, requireState, resolveAdoAccess } from "./context.ts";
import { reconcileCompletedMerges } from "./reconcile.ts";

export type PrState = "open" | "approved" | "rejected" | "completed" | "abandoned";

export type PrDisplay =
  | { kind: "none" }
  | { kind: "unknown"; id: number }
  | { kind: "loaded"; id: number; title: string; url: string; state: PrState };

export type StatusRow = {
  branch: string;
  parent: string;
  pr: PrDisplay;
  isCurrent: boolean;
  needsRestack: boolean;
  diverged: boolean;
};

export type AdoStatusAccess =
  | { kind: "ready"; loadError?: string }
  | { kind: "unavailable"; reason: "unauthenticated" | "error"; message: string };

export type NextStep = "auth-login" | "create" | "submit" | "restack" | "none";

export type StackStatus = {
  rows: StatusRow[];
  currentBranch: string;
  defaultBranch: string;
  ado: AdoStatusAccess;
  issues: string[];
  next: NextStep;
};

export async function statusCommand(ctx: AppContext): Promise<void> {
  const status = await loadStackStatus(ctx);
  renderStatus(ctx, status);
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
  const rows = order.map((branch) =>
    buildRow({
      state,
      branch,
      current,
      adoReady: access.status === "ready",
      prs,
      snapshots,
      parentTips,
    }),
  );
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

function renderStatus(ctx: AppContext, status: StackStatus): void {
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
  for (const line of forestLayout(status.rows, status.defaultBranch)) {
    ctx.log.info(`  ${line.prefix}${line.connector}${formatRowLine(line.row, prefix)}`);
    if (line.row.pr.kind === "loaded") {
      const hanging = line.connector === "└── " ? "    " : "│   ";
      ctx.log.info(`  ${line.prefix}${hanging}${line.row.pr.url}`);
    }
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

export function prStatusLabel(pr: PrDisplay): string {
  switch (pr.kind) {
    case "none":
      return "LOCAL";
    case "unknown":
      return "UNKNOWN";
    case "loaded":
      return pr.state.toUpperCase();
    default: {
      const _exhaustive: never = pr;
      throw new Error(`Unhandled PR display ${String(_exhaustive)}`);
    }
  }
}

export function rowFlags(row: StatusRow): string[] {
  const flags: string[] = [];
  if (row.isCurrent) {
    flags.push("current");
  }
  if (row.needsRestack) {
    flags.push("↑ restack needed");
  } else if (row.pr.kind === "loaded") {
    flags.push("✓ synced");
  }
  if (row.diverged) {
    flags.push("local/remote diverge");
  }
  return flags;
}

export function forestLayout(
  rows: StatusRow[],
  defaultBranch: string,
): Array<{ prefix: string; connector: string; row: StatusRow }> {
  const byParent = new Map<string, StatusRow[]>();
  for (const row of rows) {
    const list = byParent.get(row.parent) ?? [];
    list.push(row);
    byParent.set(row.parent, list);
  }
  const lines: Array<{ prefix: string; connector: string; row: StatusRow }> = [];
  const walk = (parent: string, prefix: string): void => {
    const children = byParent.get(parent) ?? [];
    for (const [index, row] of children.entries()) {
      if (!row) {
        continue;
      }
      const last = index === children.length - 1;
      lines.push({ prefix, connector: last ? "└── " : "├── ", row });
      walk(row.branch, `${prefix}${last ? "    " : "│   "}`);
    }
  };
  walk(defaultBranch, "");
  return lines;
}

function formatRowLine(row: StatusRow, prefix: string): string {
  const prLabel = row.pr.kind === "none" ? "no-pr" : `#${row.pr.id}`;
  const name = formatBranch(row.branch, prefix);
  const status = prStatusLabel(row.pr);
  const title = row.pr.kind === "loaded" && row.pr.title ? `  ${row.pr.title}` : "";
  return `${prLabel} ${name}  ${status}  ${rowFlags(row).join("  ")}${title}`.trimEnd();
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
