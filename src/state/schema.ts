export const STATE_VERSION = 1;

export type StackBranchState = {
  parent: string;
  parentTipAtCreation: string;
  lastRestackBase: string;
  lastLocalTip: string;
  lastKnownRemoteTip?: string;
  lastSubmittedTip?: string;
  pullRequestId?: number;
};

export type StackStateV1 = {
  version: 1;
  stackId?: string;
  organization: string;
  organizationName: string;
  project: string;
  repository: string;
  repositoryId?: string;
  defaultBranch: string;
  remoteName: string;
  branches: Record<string, StackBranchState>;
  untracked?: string[];
};

export type StackState = StackStateV1;

export type RestackStepStatus = "pending" | "in-progress" | "conflict" | "done";

export type RestackStep = {
  branch: string;
  onto: string;
  ontoSha: string;
  oldBase: string;
  preRebaseTip: string;
  retargetPrTo?: string;
  status: RestackStepStatus;
};

export type RestackPlanState = {
  version: 1;
  steps: RestackStep[];
};

export type ParsedState = { ok: true; state: StackState } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function parseUntracked(value: unknown): string[] | undefined {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const names: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) {
      return undefined;
    }
    if (seen.has(item)) {
      return undefined;
    }
    seen.add(item);
    names.push(item);
  }
  return names.sort();
}

function parseBranch(value: unknown): StackBranchState | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const parent = optionalString(value.parent);
  const parentTipAtCreation = optionalString(value.parentTipAtCreation);
  const lastRestackBase = optionalString(value.lastRestackBase);
  const lastLocalTip = optionalString(value.lastLocalTip);
  if (!parent || !parentTipAtCreation || !lastRestackBase || !lastLocalTip) {
    return undefined;
  }
  const branch: StackBranchState = {
    parent,
    parentTipAtCreation,
    lastRestackBase,
    lastLocalTip,
  };
  const lastKnownRemoteTip = optionalString(value.lastKnownRemoteTip);
  if (lastKnownRemoteTip) {
    branch.lastKnownRemoteTip = lastKnownRemoteTip;
  }
  const lastSubmittedTip = optionalString(value.lastSubmittedTip);
  if (lastSubmittedTip) {
    branch.lastSubmittedTip = lastSubmittedTip;
  }
  const pullRequestId = optionalNumber(value.pullRequestId);
  if (pullRequestId !== undefined) {
    branch.pullRequestId = pullRequestId;
  }
  return branch;
}

export function parseStackState(value: unknown): ParsedState {
  if (!isRecord(value)) {
    return { ok: false, error: "Stack state is not an object." };
  }
  const version = value.version;
  if (version !== 1) {
    return {
      ok: false,
      error: `Unsupported ado-stack state version ${String(version)}. This CLI understands version ${STATE_VERSION}.`,
    };
  }
  const organization = optionalString(value.organization);
  const organizationName = optionalString(value.organizationName);
  const project = optionalString(value.project);
  const repository = optionalString(value.repository);
  const defaultBranch = optionalString(value.defaultBranch);
  const remoteName = optionalString(value.remoteName);
  if (
    !organization ||
    !organizationName ||
    !project ||
    !repository ||
    !defaultBranch ||
    !remoteName
  ) {
    return { ok: false, error: "Stack state is missing required repository identity fields." };
  }
  if (!isRecord(value.branches)) {
    return { ok: false, error: "Stack state branches must be an object." };
  }
  const branches: Record<string, StackBranchState> = {};
  for (const [name, raw] of Object.entries(value.branches)) {
    const parsed = parseBranch(raw);
    if (!parsed) {
      return {
        ok: false,
        error: `Stack branch ${name} is missing required commit-boundary fields.`,
      };
    }
    branches[name] = parsed;
  }
  const untracked = parseUntracked(value.untracked);
  if (untracked === undefined) {
    return { ok: false, error: "Stack state untracked must be an array of unique branch names." };
  }
  const overlap = untracked.filter((name) => name in branches);
  if (overlap.length > 0) {
    return {
      ok: false,
      error: `Stack state lists ${overlap.join(", ")} as both tracked and untracked.`,
    };
  }
  const state: StackStateV1 = {
    version: 1,
    organization,
    organizationName,
    project,
    repository,
    defaultBranch,
    remoteName,
    branches,
  };
  if (untracked.length > 0) {
    state.untracked = untracked;
  }
  const stackId = optionalString(value.stackId);
  if (stackId) {
    state.stackId = stackId;
  }
  const repositoryId = optionalString(value.repositoryId);
  if (repositoryId) {
    state.repositoryId = repositoryId;
  }
  return { ok: true, state };
}

export function migrateState(value: unknown): ParsedState {
  return parseStackState(value);
}
