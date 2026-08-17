import { CliError } from "../errors/cli-error.ts";
import type { GitRepo } from "../git/git.ts";
import type { RestackPlanState, RestackStep, StackState } from "../state/schema.ts";
import { stackOrder } from "./graph.ts";

export type PullRequestSnapshot = {
  id: number;
  status: "active" | "completed" | "abandoned" | "notSet";
  sourceBranch: string;
  targetBranch: string;
};

export type RestackAssessment = {
  branch: string;
  currentParent: string;
  effectiveParent: string;
  ontoSha: string;
  oldBase: string;
  preRebaseTip: string;
  parentCompleted: boolean;
  needsRebase: boolean;
  retargetPrTo?: string;
};

function stripRefsHeads(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}

export function effectiveParent(options: {
  state: StackState;
  branch: string;
  pullRequests: Map<number, PullRequestSnapshot>;
}): { parent: string; skipped: string[]; parentCompleted: boolean } {
  const record = options.state.branches[options.branch];
  if (!record) {
    throw new CliError(`\`${options.branch}\` is not tracked.`);
  }
  const skipped: string[] = [];
  let parent = record.parent;
  let parentCompleted = false;
  const seen = new Set<string>();
  while (parent !== options.state.defaultBranch) {
    if (seen.has(parent)) {
      throw new CliError(`Stack contains a cycle at \`${parent}\`.`);
    }
    seen.add(parent);
    const parentRecord = options.state.branches[parent];
    if (!parentRecord?.pullRequestId) {
      break;
    }
    const pr = options.pullRequests.get(parentRecord.pullRequestId);
    if (!pr) {
      break;
    }
    if (pr.status === "abandoned") {
      throw new CliError(
        `Cannot restack \`${options.branch}\` because parent \`${parent}\` has an abandoned PR (#${pr.id}).\n\nReopen that PR, retarget manually, or repair local state. ado-stack will not guess a new base.`,
      );
    }
    if (pr.status !== "completed") {
      break;
    }
    parentCompleted = true;
    skipped.push(parent);
    parent = parentRecord.parent;
  }
  return { parent, skipped, parentCompleted };
}

export async function assessBranch(options: {
  git: GitRepo;
  state: StackState;
  branch: string;
  pullRequests: Map<number, PullRequestSnapshot>;
}): Promise<RestackAssessment> {
  const record = options.state.branches[options.branch];
  if (!record) {
    throw new CliError(`\`${options.branch}\` is not tracked.`);
  }
  const resolved = effectiveParent({
    state: options.state,
    branch: options.branch,
    pullRequests: options.pullRequests,
  });
  const ontoSha = await resolveOntoSha(options.git, options.state, resolved.parent);
  const preRebaseTip = await options.git.getBranchTip(options.branch);
  const needsRebase = resolved.parentCompleted || record.lastRestackBase !== ontoSha;
  const assessment: RestackAssessment = {
    branch: options.branch,
    currentParent: record.parent,
    effectiveParent: resolved.parent,
    ontoSha,
    oldBase: record.lastRestackBase,
    preRebaseTip,
    parentCompleted: resolved.parentCompleted,
    needsRebase,
  };
  if (resolved.parent !== record.parent) {
    assessment.retargetPrTo = resolved.parent;
  }
  return assessment;
}

export async function resolveOntoSha(
  git: GitRepo,
  state: StackState,
  parent: string,
): Promise<string> {
  if (parent === state.defaultBranch) {
    const remoteExists = await git.remoteBranchExists(state.remoteName, parent);
    if (remoteExists) {
      return git.getBranchTip(`${state.remoteName}/${parent}`);
    }
  }
  return git.getBranchTip(parent);
}

export async function planRestack(options: {
  git: GitRepo;
  state: StackState;
  pullRequests: Map<number, PullRequestSnapshot>;
}): Promise<RestackPlanState> {
  const steps: RestackStep[] = [];
  let ancestorRewritten = false;
  for (const branch of stackOrder(options.state)) {
    const record = options.state.branches[branch];
    const ownPr =
      record?.pullRequestId === undefined
        ? undefined
        : options.pullRequests.get(record.pullRequestId);
    if (ownPr?.status === "completed") {
      continue;
    }
    const assessment = await assessBranch({ ...options, branch });
    if (!assessment.needsRebase && !ancestorRewritten) {
      continue;
    }
    ancestorRewritten = true;
    const step: RestackStep = {
      branch,
      onto: assessment.effectiveParent,
      ontoSha: assessment.ontoSha,
      oldBase: assessment.oldBase,
      preRebaseTip: assessment.preRebaseTip,
      status: "pending",
    };
    if (assessment.retargetPrTo) {
      step.retargetPrTo = assessment.retargetPrTo;
    }
    steps.push(step);
  }
  return { version: 1, steps };
}

export async function assertSafeRewrite(options: {
  git: GitRepo;
  state: StackState;
  branch: string;
  remoteName: string;
}): Promise<void> {
  const record = options.state.branches[options.branch];
  if (!record) {
    throw new CliError(
      `Cannot rewrite \`${options.branch}\`.\n\nIt is not part of the tracked stack. No remote history was overwritten.`,
    );
  }
  const existsRemote = await options.git.remoteBranchExists(options.remoteName, options.branch);
  if (!existsRemote) {
    return;
  }
  const actualRemoteTip = await options.git.getBranchTip(`${options.remoteName}/${options.branch}`);
  const expected = record.lastKnownRemoteTip;
  if (!expected) {
    const localTip = await options.git.getBranchTip(options.branch);
    if (actualRemoteTip !== localTip) {
      throw divergenceError(
        options.branch,
        "(unknown, never synced by ado-stack)",
        actualRemoteTip,
      );
    }
    return;
  }
  if (actualRemoteTip !== expected) {
    throw divergenceError(options.branch, expected, actualRemoteTip);
  }
}

function divergenceError(branch: string, expected: string, actual: string): CliError {
  return new CliError(
    `Cannot rewrite \`${branch}\`.\n\nExpected remote tip:\n  ${shortSha(expected)}\n\nActual remote tip:\n  ${shortSha(actual)}\n\nThe remote branch changed since your last sync. Fetch and inspect the new commits before restacking.\n\nNo remote history was overwritten.`,
  );
}

export function shortSha(sha: string): string {
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}

export async function executeRestackStep(options: {
  git: GitRepo;
  state: StackState;
  step: RestackStep;
}): Promise<StackState> {
  const record = options.state.branches[options.step.branch];
  if (!record) {
    throw new CliError(`\`${options.step.branch}\` is not tracked.`);
  }
  if (options.step.oldBase === options.step.ontoSha) {
    const newTip = await options.git.getBranchTip(options.step.branch);
    return applyRestackStepToState(options.state, options.step, newTip);
  }
  const unique = await options.git.getCommitsBetween(options.step.oldBase, options.step.branch);
  if (unique.length === 0) {
    throw new CliError(
      `Refusing to restack \`${options.step.branch}\` because it has no unique commits relative to ${shortSha(options.step.oldBase)}.\n\nThe recorded commit range is empty. Inspect the branch before rewriting history.`,
    );
  }
  const rangePlausible = await options.git.isAncestor(options.step.oldBase, options.step.branch);
  if (!rangePlausible) {
    throw new CliError(
      `Refusing to restack \`${options.step.branch}\`.\n\nRecorded base ${shortSha(options.step.oldBase)} is not an ancestor of the branch. Local history does not match ado-stack state.\n\nNo remote history was overwritten.`,
    );
  }
  await assertSafeRewrite({
    git: options.git,
    state: options.state,
    branch: options.step.branch,
    remoteName: options.state.remoteName,
  });
  try {
    await options.git.rebaseOnto({
      newBase: options.step.ontoSha,
      oldBase: options.step.oldBase,
      branch: options.step.branch,
    });
  } catch (error) {
    const conflict = await options.git.rebaseInProgress();
    if (conflict) {
      throw new RestackConflictError(options.step.branch, error);
    }
    throw error;
  }
  const newTip = await options.git.getBranchTip(options.step.branch);
  return applyRestackStepToState(options.state, options.step, newTip);
}

export function applyRestackStepToState(
  state: StackState,
  step: RestackStep,
  newTip: string,
): StackState {
  const record = state.branches[step.branch];
  if (!record) {
    throw new CliError(`\`${step.branch}\` is not tracked.`);
  }
  const next: StackState = {
    ...state,
    branches: {
      ...state.branches,
      [step.branch]: {
        ...record,
        parent: step.onto,
        lastRestackBase: step.ontoSha,
        lastLocalTip: newTip,
      },
    },
  };
  for (const skipped of completedAncestorsDropped(state, step)) {
    delete next.branches[skipped];
  }
  return next;
}

function completedAncestorsDropped(state: StackState, step: RestackStep): string[] {
  if (!step.retargetPrTo) {
    return [];
  }
  const dropped: string[] = [];
  let current = state.branches[step.branch]?.parent;
  while (current && current !== step.onto && current !== state.defaultBranch) {
    dropped.push(current);
    current = state.branches[current]?.parent;
  }
  return dropped;
}

export class RestackConflictError extends CliError {
  readonly branch: string;

  constructor(branch: string, cause: unknown) {
    super(
      `Restack stopped on \`${branch}\` because Git reported a rebase conflict.\n\nGit's rebase state has been left in place. ado-stack did not reset or discard your work.\n\nResolve the conflicted files, then:\n  git add <files>\n  git rebase --continue\n  ado-stack restack --continue\n\nTo abandon this restack attempt:\n  ado-stack restack --abort`,
      { cause, exitCode: 1 },
    );
    this.name = "RestackConflictError";
    this.branch = branch;
  }
}

export function markStep(
  plan: RestackPlanState,
  branch: string,
  status: RestackStep["status"],
): RestackPlanState {
  return {
    ...plan,
    steps: plan.steps.map((step) => (step.branch === branch ? { ...step, status } : step)),
  };
}
