import { CliError } from "../errors/cli-error.ts";
import type { StackState } from "../state/schema.ts";
import { childrenOf, parentOf, requireTracked } from "./graph.ts";

export function upBranch(state: StackState, current: string, requested?: string): string {
  if (current !== state.defaultBranch) {
    requireTracked(state, current);
  }
  const children = childrenOf(state, current);
  if (requested !== undefined) {
    if (!children.includes(requested)) {
      const available =
        children.length === 0
          ? "it has no children"
          : `children: ${children.map((name) => `\`${name}\``).join(", ")}`;
      throw new CliError(`\`${requested}\` is not a child of \`${current}\` (${available}).`);
    }
    return requested;
  }
  if (children.length === 0) {
    if (current === state.defaultBranch) {
      throw new CliError("The stack is empty. Create a branch with `ado-stack create <name>`.");
    }
    throw new CliError(
      `Already at the top of the stack (\`${current}\`).\n\nThere is no child branch to check out.`,
    );
  }
  const [only] = children;
  if (children.length === 1 && only) {
    return only;
  }
  throw new CliError(
    `\`${current}\` has multiple children:\n${children.map((name) => `  ${name}`).join("\n")}\n\nRun \`ado-stack up <branch>\` to choose one.`,
  );
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
