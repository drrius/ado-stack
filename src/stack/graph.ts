import { CliError } from "../errors/cli-error.ts";
import type { StackState } from "../state/schema.ts";

export function childOf(state: StackState, parent: string): string | undefined {
  const children = Object.entries(state.branches)
    .filter(([, branch]) => branch.parent === parent)
    .map(([name]) => name);
  if (children.length > 1) {
    throw new CliError(
      `Stack is not linear. \`${parent}\` has multiple children: ${children.join(", ")}.\n\nado-stack v1 supports a single line of PRs. Repair the stack or drop extra branches from local state.`,
    );
  }
  return children[0];
}

export function stackOrder(state: StackState): string[] {
  const order: string[] = [];
  let current = childOf(state, state.defaultBranch);
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current)) {
      throw new CliError(`Stack contains a cycle at \`${current}\`.`);
    }
    seen.add(current);
    order.push(current);
    current = childOf(state, current);
  }
  const leftovers = Object.keys(state.branches).filter((name) => !seen.has(name));
  if (leftovers.length > 0) {
    throw new CliError(
      `These branches are tracked but not connected to \`${state.defaultBranch}\`:\n${leftovers.map((name) => `  ${name}`).join("\n")}\n\nRun \`ado-stack status\` and repair the parent links before continuing.`,
    );
  }
  return order;
}

export function stackTip(state: StackState): string | undefined {
  const order = stackOrder(state);
  return order[order.length - 1];
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
