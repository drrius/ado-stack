import type { StackPrMetadata } from "../ado/properties.ts";
import type { PullRequestStatus } from "../ado/types.ts";
import type { StackBranchState, StackState } from "../state/schema.ts";
import { findCycle, missingParents } from "./graph.ts";

export type ReconstructPullRequest = {
  id: number;
  status: PullRequestStatus;
  sourceBranch: string;
  targetBranch: string;
  lastMergeSourceCommit?: string;
  properties?: StackPrMetadata;
};

export type ReconstructConflict =
  | { kind: "empty" }
  | { kind: "multiple-stack-ids"; stackIds: string[] }
  | { kind: "duplicate-source"; branch: string; pullRequestIds: number[] }
  | {
      kind: "parent-mismatch";
      branch: string;
      recordedParent?: string;
      propertyParent?: string;
      prTarget: string;
    }
  | { kind: "missing-parent"; branch: string; parent: string }
  | { kind: "cycle"; branches: string[] };

export type AdoptionSkip = {
  pullRequestId: number;
  sourceBranch: string;
  reason: string;
};

export type ReconstructResult =
  | { ok: true; state: StackState; skipped: AdoptionSkip[] }
  | { ok: false; conflicts: ReconstructConflict[]; skipped: AdoptionSkip[] };

export function reconstructForest(options: {
  base: StackState;
  pullRequests: ReconstructPullRequest[];
}): ReconstructResult {
  const skipped: AdoptionSkip[] = [];
  const adoptable = adoptablePullRequests(
    options.base.defaultBranch,
    options.pullRequests,
    skipped,
  );
  const propertyIds = [
    ...new Set(
      adoptable.map((pr) => pr.properties?.stackId).filter((id): id is string => Boolean(id)),
    ),
  ].sort();
  if (propertyIds.length > 1) {
    return fail(options.pullRequests, skipped, [
      { kind: "multiple-stack-ids", stackIds: propertyIds },
    ]);
  }
  if (adoptable.length === 0) {
    return fail(options.pullRequests, skipped, [{ kind: "empty" }]);
  }

  const bySource = new Map<string, ReconstructPullRequest[]>();
  for (const pr of adoptable) {
    const list = bySource.get(pr.sourceBranch) ?? [];
    list.push(pr);
    bySource.set(pr.sourceBranch, list);
  }

  const conflicts: ReconstructConflict[] = [];
  const chosen: ReconstructPullRequest[] = [];
  for (const [branch, prs] of bySource) {
    const choice = choosePullRequestForSource(prs);
    if (!choice.ok) {
      conflicts.push({
        kind: "duplicate-source",
        branch,
        pullRequestIds: choice.pullRequestIds,
      });
      continue;
    }
    const pr = choice.pr;
    const propertyParent = pr.properties?.parent;
    const recordedParent = options.base.branches[branch]?.parent;
    if (propertyParent !== undefined && propertyParent !== pr.targetBranch) {
      conflicts.push({
        kind: "parent-mismatch",
        branch,
        propertyParent,
        recordedParent,
        prTarget: pr.targetBranch,
      });
      continue;
    }
    if (recordedParent !== undefined && recordedParent !== pr.targetBranch) {
      conflicts.push({
        kind: "parent-mismatch",
        branch,
        recordedParent,
        propertyParent,
        prTarget: pr.targetBranch,
      });
      continue;
    }
    chosen.push(pr);
  }

  if (conflicts.length > 0) {
    return fail(options.pullRequests, skipped, conflicts);
  }

  const branches: Record<string, StackBranchState> = {};
  for (const pr of chosen) {
    const recorded = options.base.branches[pr.sourceBranch];
    const restackBase =
      pr.properties?.lastRestackBase ??
      (recorded?.parent === pr.targetBranch ? recorded.lastRestackBase : undefined) ??
      pr.targetBranch;
    const tip =
      pr.lastMergeSourceCommit ??
      (recorded?.parent === pr.targetBranch ? recorded.lastLocalTip : undefined) ??
      restackBase;
    branches[pr.sourceBranch] = {
      parent: pr.targetBranch,
      parentTipAtCreation:
        recorded?.parent === pr.targetBranch ? recorded.parentTipAtCreation : restackBase,
      lastRestackBase: restackBase,
      lastLocalTip: tip,
      lastKnownRemoteTip: pr.lastMergeSourceCommit ?? recorded?.lastKnownRemoteTip,
      lastSubmittedTip: pr.lastMergeSourceCommit ?? recorded?.lastSubmittedTip,
      pullRequestId: pr.id,
    };
  }

  const next: StackState = {
    ...options.base,
    branches,
  };
  if (propertyIds[0]) {
    next.stackId = propertyIds[0];
  }

  const missing = missingParents(next);
  for (const item of missing) {
    conflicts.push({ kind: "missing-parent", branch: item.branch, parent: item.parent });
  }
  const cycle = findCycle(next);
  if (cycle) {
    conflicts.push({ kind: "cycle", branches: cycle });
  }
  if (conflicts.length > 0) {
    return fail(options.pullRequests, skipped, conflicts);
  }
  accountUnadoptedActivePullRequests(options.pullRequests, adoptedPullRequestIds(next), skipped);
  return { ok: true, state: next, skipped };
}

export function formatReconstructConflicts(conflicts: ReconstructConflict[]): string {
  return conflicts.map(formatConflict).join("\n");
}

function formatConflict(conflict: ReconstructConflict): string {
  switch (conflict.kind) {
    case "empty":
      return "No pull requests with a target branch were available to adopt.";
    case "multiple-stack-ids":
      return `Found ${conflict.stackIds.length} ado-stack IDs on pull requests (${conflict.stackIds.join(", ")}). Not guessing which stack to adopt.`;
    case "duplicate-source":
      return `\`${conflict.branch}\` has more than one pull request (${conflict.pullRequestIds.map((id) => `#${id}`).join(", ")}).`;
    case "parent-mismatch": {
      const parts = [`PR target \`${conflict.prTarget}\``];
      if (conflict.propertyParent !== undefined) {
        parts.push(`recorded ado-stack parent \`${conflict.propertyParent}\``);
      }
      if (conflict.recordedParent !== undefined) {
        parts.push(`local parent \`${conflict.recordedParent}\``);
      }
      return `\`${conflict.branch}\` has disagreeing parents: ${parts.join("; ")}.`;
    }
    case "missing-parent":
      return `\`${conflict.branch}\` targets \`${conflict.parent}\`, which is not trunk and is not a pull request source.`;
    case "cycle":
      return `Parent links form a cycle: ${conflict.branches.join(" → ")}.`;
    default: {
      const _exhaustive: never = conflict;
      return _exhaustive;
    }
  }
}

function adoptablePullRequests(
  defaultBranch: string,
  pullRequests: ReconstructPullRequest[],
  skipped: AdoptionSkip[],
): ReconstructPullRequest[] {
  const bySource = new Map<string, ReconstructPullRequest[]>();
  for (const pr of pullRequests) {
    if (pr.status === "abandoned") {
      continue;
    }
    const list = bySource.get(pr.sourceBranch) ?? [];
    list.push(pr);
    bySource.set(pr.sourceBranch, list);
  }

  const needed = new Set<string>();
  const walk = (branch: string, seen: Set<string>): void => {
    if (branch === defaultBranch || needed.has(branch) || seen.has(branch)) {
      return;
    }
    seen.add(branch);
    const prs = bySource.get(branch);
    if (!prs || prs.length === 0) {
      return;
    }
    needed.add(branch);
    const choice = choosePullRequestForSource(prs);
    if (choice.ok) {
      walk(choice.pr.properties?.parent ?? choice.pr.targetBranch, seen);
      return;
    }
    for (const pr of prs.filter((item) => item.status === "active")) {
      walk(pr.properties?.parent ?? pr.targetBranch, seen);
    }
  };

  for (const pr of pullRequests) {
    if (pr.status !== "active") {
      continue;
    }
    if (pr.sourceBranch === defaultBranch) {
      skipped.push({
        pullRequestId: pr.id,
        sourceBranch: pr.sourceBranch,
        reason: "source branch is the default branch",
      });
      continue;
    }
    walk(pr.sourceBranch, new Set());
  }

  const chosen: ReconstructPullRequest[] = [];
  for (const branch of needed) {
    chosen.push(...(bySource.get(branch) ?? []));
  }
  return chosen;
}

function choosePullRequestForSource(
  prs: ReconstructPullRequest[],
): { ok: true; pr: ReconstructPullRequest } | { ok: false; pullRequestIds: number[] } {
  const active = prs.filter((pr) => pr.status === "active");
  if (active.length > 1) {
    return { ok: false, pullRequestIds: active.map((pr) => pr.id) };
  }
  const [onlyActive] = active;
  if (onlyActive) {
    return { ok: true, pr: onlyActive };
  }
  const [only] = prs;
  if (only && prs.length === 1) {
    return { ok: true, pr: only };
  }
  return { ok: false, pullRequestIds: prs.map((pr) => pr.id) };
}

function fail(
  pullRequests: ReconstructPullRequest[],
  skipped: AdoptionSkip[],
  conflicts: ReconstructConflict[],
): ReconstructResult {
  accountUnadoptedActivePullRequests(pullRequests, new Set(), skipped);
  return { ok: false, conflicts, skipped };
}

function adoptedPullRequestIds(state: StackState): Set<number> {
  return new Set(
    Object.values(state.branches).flatMap((branch) =>
      branch.pullRequestId === undefined ? [] : [branch.pullRequestId],
    ),
  );
}

function accountUnadoptedActivePullRequests(
  pullRequests: ReconstructPullRequest[],
  adoptedIds: Set<number>,
  skipped: AdoptionSkip[],
): void {
  const named = new Set(skipped.map((skip) => skip.pullRequestId));
  for (const pr of pullRequests) {
    if (pr.status !== "active" || adoptedIds.has(pr.id) || named.has(pr.id)) {
      continue;
    }
    skipped.push({
      pullRequestId: pr.id,
      sourceBranch: pr.sourceBranch,
      reason: "not included in the reconstructed forest",
    });
    named.add(pr.id);
  }
}
