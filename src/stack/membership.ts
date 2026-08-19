import type { PullRequestStatus } from "../ado/types.ts";
import type { StackState } from "../state/schema.ts";

export type UntrackedPruneEvidence = {
  pullRequests: ReadonlyArray<{ sourceBranch: string; status: PullRequestStatus }>;
  branchExists: (name: string) => boolean;
  remoteBranchExists: (name: string) => boolean;
};

export function untrackedNames(state: StackState): string[] {
  return state.untracked ?? [];
}

export function isUntracked(state: StackState, branch: string): boolean {
  return untrackedNames(state).includes(branch);
}

export function setUntracked(state: StackState, names: readonly string[]): void {
  const unique = [...new Set(names.filter((name) => name.length > 0))].sort();
  if (unique.length === 0) {
    state.untracked = undefined;
    return;
  }
  state.untracked = unique;
}

export function excludeFromStack(state: StackState, branch: string): void {
  delete state.branches[branch];
  setUntracked(state, [...untrackedNames(state), branch]);
}

export function releaseUntracked(state: StackState, branch: string): void {
  setUntracked(
    state,
    untrackedNames(state).filter((name) => name !== branch),
  );
}

export function pruneUntracked(state: StackState, evidence: UntrackedPruneEvidence): string[] {
  const kept: string[] = [];
  const pruned: string[] = [];
  for (const name of untrackedNames(state)) {
    if (keepUntracked(name, evidence)) {
      kept.push(name);
    } else {
      pruned.push(name);
    }
  }
  setUntracked(state, kept);
  return pruned;
}

function keepUntracked(name: string, evidence: UntrackedPruneEvidence): boolean {
  const related = evidence.pullRequests.filter((pr) => pr.sourceBranch === name);
  if (related.some((pr) => pr.status === "active")) {
    return true;
  }
  if (related.some((pr) => pr.status === "completed" || pr.status === "abandoned")) {
    return false;
  }
  return evidence.branchExists(name) || evidence.remoteBranchExists(name);
}
