import { CliError } from "../errors/cli-error.ts";
import { excludeFromStack, isUntracked, untrackedNames } from "../stack/membership.ts";
import { resolveBranchArg } from "../stack/names.ts";
import { formatBranch } from "../ui/format.ts";
import { type AppContext, requireState } from "./context.ts";

export async function untrackCommand(
  ctx: AppContext,
  args: string[],
  flags: Record<string, string | boolean> = {},
): Promise<void> {
  if (flags.list === true) {
    const state = await requireState(ctx);
    const names = untrackedNames(state);
    if (names.length === 0) {
      ctx.log.info("No untracked branches.");
      return;
    }
    for (const name of names) {
      ctx.log.info(formatBranch(name, ctx.config.branchPrefix));
    }
    return;
  }
  const arg = args[0];
  if (!arg) {
    throw new CliError("Usage: ado-stack untrack <branch>");
  }
  const state = await requireState(ctx);
  const branch = resolveBranchArg(arg, {
    prefix: ctx.config.branchPrefix,
    known: Object.keys(state.branches),
  });
  if (isUntracked(state, branch)) {
    throw new CliError(`\`${branch}\` is already untracked.`);
  }
  if (!state.branches[branch]) {
    throw new CliError(`\`${branch}\` is not tracked.`);
  }
  if (await ctx.stateStore.readRestackPlan()) {
    throw new CliError(
      "A restack is in progress.\n\nFinish it with `ado-stack restack --continue` or `ado-stack restack --abort` before untracking.",
    );
  }
  const children = Object.entries(state.branches)
    .filter(([, record]) => record.parent === branch)
    .map(([name]) => name);
  if (children.length > 0) {
    throw new CliError(
      `Cannot untrack \`${branch}\` because tracked branches are stacked on it:\n${children
        .map((name) => `  ${name}`)
        .join("\n")}\n\nUntrack the children first, or let them merge and restack.`,
    );
  }
  excludeFromStack(state, branch);
  await ctx.stateStore.write(state);
  ctx.log.success(
    `Untracked ${formatBranch(branch, ctx.config.branchPrefix)}. The Git branch and any pull request were not changed.`,
  );
}
