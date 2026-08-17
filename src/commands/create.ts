import { CliError } from "../errors/cli-error.ts";
import { childOf, isTracked } from "../stack/graph.ts";
import { applyBranchPrefix, validateBranchName } from "../stack/names.ts";
import type { AppContext } from "./context.ts";
import { requireState } from "./context.ts";

export async function createCommand(ctx: AppContext, args: string[]): Promise<void> {
  const rawName = args[0];
  if (!rawName) {
    throw new CliError("Usage: ado-stack create <name>");
  }
  const state = await requireState(ctx);
  const current = await ctx.git.currentBranch();
  if (!current) {
    throw new CliError("HEAD is detached. Check out a stack branch or the default branch first.");
  }
  await ctx.git.requireCleanTrackedTree("create a stack branch");
  const name = applyBranchPrefix(rawName, ctx.config.branchPrefix);
  validateBranchName(name);
  if (name === state.defaultBranch) {
    throw new CliError(`\`${name}\` is the default branch. Choose a different stack branch name.`);
  }
  if (await ctx.git.branchExists(name)) {
    throw new CliError(`Branch \`${name}\` already exists.`);
  }
  if (isTracked(state, name)) {
    throw new CliError(`\`${name}\` is already tracked in the stack.`);
  }
  if (current !== state.defaultBranch && !isTracked(state, current)) {
    throw new CliError(
      `Current branch \`${current}\` is not the default branch and is not in the stack.\n\nCheck out \`${state.defaultBranch}\` or a tracked stack branch first.`,
    );
  }
  const existingChild = childOf(state, current);
  if (existingChild) {
    throw new CliError(
      `\`${current}\` already has a child \`${existingChild}\`.\n\nado-stack v1 is linear. Check out \`${existingChild}\` to extend the stack, or restack first.`,
    );
  }
  const parentTip = await ctx.git.getBranchTip(current);
  await ctx.git.checkoutNewBranch(name);
  const tip = await ctx.git.getBranchTip(name);
  state.branches[name] = {
    parent: current,
    parentTipAtCreation: parentTip,
    lastRestackBase: parentTip,
    lastLocalTip: tip,
  };
  await ctx.stateStore.write(state);
  ctx.log.success(`Created \`${name}\` on top of \`${current}\`.`);
  ctx.log.info("Commit on this branch, then `ado-stack create` again or `ado-stack submit`.");
}
