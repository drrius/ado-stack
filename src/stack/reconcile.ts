import { CliError } from "../errors/cli-error.ts";
import type { StackState } from "../state/schema.ts";
import { childrenOf, stackOrder } from "./graph.ts";
import { type PullRequestSnapshot, effectiveParent } from "./restack.ts";

export type LocalBranchDisposition =
  | { kind: "delete" }
  | { kind: "keep"; reason: "not-contained" | "missing" | "checked-out" | "held-by-worktree" };

export type MergeChild = {
  branch: string;
  pullRequestId?: number;
};

export type MergeAbsorption = {
  branch: string;
  pullRequestId: number;
  into: string;
  children: MergeChild[];
  local: LocalBranchDisposition;
};

export type ReconcilePlan = {
  absorptions: MergeAbsorption[];
};

export type GitReconcileFacts = {
  currentBranch: string | undefined;
  heldBranches: ReadonlySet<string>;
  branchExists: (branch: string) => boolean;
  containedIn: (branch: string, into: string) => boolean;
};

export function planCompletedMerges(options: {
  state: StackState;
  pullRequests: Map<number, PullRequestSnapshot>;
  facts: GitReconcileFacts;
}): ReconcilePlan {
  const absorptions: MergeAbsorption[] = [];
  for (const branch of stackOrder(options.state)) {
    const record = options.state.branches[branch];
    const pullRequestId = record?.pullRequestId;
    if (pullRequestId === undefined) {
      continue;
    }
    const snapshot = options.pullRequests.get(pullRequestId);
    if (snapshot?.status !== "completed") {
      continue;
    }
    const into = effectiveParent({
      state: options.state,
      branch,
      pullRequests: options.pullRequests,
    }).parent;
    absorptions.push({
      branch,
      pullRequestId,
      into,
      children: mergeChildren(options.state, branch),
      local: localDisposition(options.facts, branch, into),
    });
  }
  return { absorptions };
}

export function applyAbsorption(state: StackState, absorption: MergeAbsorption): StackState {
  const next: StackState = {
    ...state,
    branches: { ...state.branches },
  };
  for (const child of absorption.children) {
    const record = next.branches[child.branch];
    if (!record) {
      throw new CliError(
        `Cannot absorb \`${absorption.branch}\`: child \`${child.branch}\` is not tracked.`,
      );
    }
    next.branches[child.branch] = {
      ...record,
      parent: absorption.into,
    };
  }
  delete next.branches[absorption.branch];
  return next;
}

function mergeChildren(state: StackState, branch: string): MergeChild[] {
  return childrenOf(state, branch).map((name) => {
    const pullRequestId = state.branches[name]?.pullRequestId;
    if (pullRequestId === undefined) {
      return { branch: name };
    }
    return { branch: name, pullRequestId };
  });
}

function localDisposition(
  facts: GitReconcileFacts,
  branch: string,
  into: string,
): LocalBranchDisposition {
  if (!facts.branchExists(branch)) {
    return { kind: "keep", reason: "missing" };
  }
  if (facts.currentBranch === branch) {
    return { kind: "keep", reason: "checked-out" };
  }
  if (facts.heldBranches.has(branch)) {
    return { kind: "keep", reason: "held-by-worktree" };
  }
  if (!facts.containedIn(branch, into)) {
    return { kind: "keep", reason: "not-contained" };
  }
  return { kind: "delete" };
}
