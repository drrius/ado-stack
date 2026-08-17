import { CliError } from "../errors/cli-error.ts";
import type { StackState } from "../state/schema.ts";
import { childOf, parentOf, requireTracked } from "./graph.ts";

export function upBranch(state: StackState, current: string): string {
  if (current === state.defaultBranch) {
    const first = childOf(state, state.defaultBranch);
    if (!first) {
      throw new CliError("The stack is empty. Create a branch with `ado-stack create <name>`.");
    }
    return first;
  }
  requireTracked(state, current);
  const child = childOf(state, current);
  if (!child) {
    throw new CliError(
      `Already at the top of the stack (\`${current}\`).\n\nThere is no child branch to check out.`,
    );
  }
  return child;
}

export function downBranch(state: StackState, current: string): string {
  if (current === state.defaultBranch) {
    throw new CliError(
      `Already at the bottom of the stack (\`${state.defaultBranch}\`).\n\nThere is no parent branch to check out.`,
    );
  }
  requireTracked(state, current);
  const parent = parentOf(state, current);
  if (!parent) {
    throw new CliError(`\`${current}\` has no recorded parent.`);
  }
  return parent;
}
