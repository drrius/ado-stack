import { CliError } from "../errors/cli-error.ts";
import type { StackState } from "../state/schema.ts";

export function childrenOf(state: StackState, parent: string): string[] {
  return Object.entries(state.branches)
    .filter(([, branch]) => branch.parent === parent)
    .map(([name]) => name)
    .sort((left, right) => compareSiblings(state, left, right));
}

function compareSiblings(state: StackState, left: string, right: string): number {
  const leftId = state.branches[left]?.pullRequestId;
  const rightId = state.branches[right]?.pullRequestId;
  if (leftId !== undefined && rightId !== undefined && leftId !== rightId) {
    return leftId - rightId;
  }
  if (leftId !== undefined && rightId === undefined) {
    return -1;
  }
  if (leftId === undefined && rightId !== undefined) {
    return 1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

export function parentOf(state: StackState, branch: string): string | undefined {
  return state.branches[branch]?.parent;
}

export function isTracked(state: StackState, branch: string): boolean {
  return branch in state.branches;
}

export function requireTracked(state: StackState, branch: string): void {
  if (!isTracked(state, branch) && branch !== state.defaultBranch) {
    throw new CliError(
      `\`${branch}\` is not part of the tracked stack.\n\nRun \`ado-stack status\` to see the current stack, or \`ado-stack create\` to add a branch.`,
    );
  }
}

export function missingParents(state: StackState): Array<{ branch: string; parent: string }> {
  return Object.entries(state.branches)
    .filter(
      ([, branch]) => branch.parent !== state.defaultBranch && !(branch.parent in state.branches),
    )
    .map(([name, branch]) => ({ branch: name, parent: branch.parent }));
}

export function findCycle(state: StackState): string[] | undefined {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];

  const visit = (name: string): string[] | undefined => {
    if (visited.has(name) || name === state.defaultBranch) {
      return undefined;
    }
    if (visiting.has(name)) {
      const start = path.indexOf(name);
      const loop = start >= 0 ? path.slice(start) : [name];
      return [...loop, name];
    }
    visiting.add(name);
    path.push(name);
    const parent = state.branches[name]?.parent;
    if (parent && parent !== state.defaultBranch && parent in state.branches) {
      const cycle = visit(parent);
      if (cycle) {
        return cycle;
      }
    }
    path.pop();
    visiting.delete(name);
    visited.add(name);
    return undefined;
  };

  for (const name of Object.keys(state.branches)) {
    const cycle = visit(name);
    if (cycle) {
      return cycle;
    }
  }
  return undefined;
}

export function assertForest(state: StackState): void {
  const cycle = findCycle(state);
  if (cycle) {
    throw new CliError(`Stack contains a cycle: ${cycle.join(" → ")}.`);
  }
  const missing = missingParents(state);
  if (missing.length > 0) {
    const lines = missing.map((item) => `  \`${item.branch}\` → missing parent \`${item.parent}\``);
    throw new CliError(
      `These branches record a parent that is not trunk and is not tracked:\n${lines.join("\n")}`,
    );
  }
}

export function stackOrder(state: StackState): string[] {
  assertForest(state);
  const order: string[] = [];
  const walk = (parent: string): void => {
    for (const child of childrenOf(state, parent)) {
      order.push(child);
      walk(child);
    }
  };
  walk(state.defaultBranch);
  return order;
}

export function descendantsOf(state: StackState, branch: string): string[] {
  const found: string[] = [];
  const walk = (parent: string): void => {
    for (const child of childrenOf(state, parent)) {
      found.push(child);
      walk(child);
    }
  };
  walk(branch);
  return found;
}
