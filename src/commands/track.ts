import { CliError } from "../errors/cli-error.ts";
import { hydrateForestTips } from "../stack/hydrate.ts";
import { isUntracked, releaseUntracked, untrackedNames } from "../stack/membership.ts";
import { resolveBranchArg } from "../stack/names.ts";
import { formatReconstructConflicts } from "../stack/reconstruct.ts";
import type { StackState } from "../state/schema.ts";
import { formatBranch } from "../ui/format.ts";
import { type AppContext, createAdoClient, requireState } from "./context.ts";
import { reconstructFromAdo } from "./init.ts";
import { reconcileCompletedMerges } from "./reconcile.ts";

export async function trackCommand(ctx: AppContext, args: string[]): Promise<void> {
  const arg = args[0];
  if (!arg) {
    throw new CliError("Usage: ado-stack track <branch>");
  }
  const state = await requireState(ctx);
  const branch = resolveBranchArg(arg, {
    prefix: ctx.config.branchPrefix,
    known: [...untrackedNames(state), ...Object.keys(state.branches)],
  });
  if (state.branches[branch]) {
    throw new CliError(`\`${branch}\` is already tracked.`);
  }
  if (!isUntracked(state, branch)) {
    throw new CliError(`\`${branch}\` is not untracked.`);
  }
  if (await ctx.stateStore.readRestackPlan()) {
    throw new CliError(
      "A restack is in progress.\n\nFinish it with `ado-stack restack --continue` or `ado-stack restack --abort` before tracking.",
    );
  }
  const next: StackState = {
    ...state,
    branches: { ...state.branches },
    untracked: state.untracked ? [...state.untracked] : undefined,
  };
  releaseUntracked(next, branch);
  const ado = await createAdoClient(ctx, next);
  const rebuilt = await reconstructFromAdo(ctx, ado, next);
  if (!rebuilt.ok) {
    throw new CliError(
      `Could not adopt \`${branch}\` back into the stack.\n\n${formatReconstructConflicts(rebuilt.conflicts)}`,
    );
  }
  if (!rebuilt.state.branches[branch]) {
    throw new CliError(
      `Could not adopt \`${branch}\` back into the stack.\n\nNo adoptable pull request remains for that source branch.`,
    );
  }
  const hydrated = await hydrateForestTips(ctx.git, rebuilt.state);
  const reconciled = await reconcileCompletedMerges(ctx, hydrated);
  await ctx.stateStore.write(reconciled);
  ctx.log.success(`Tracked ${formatBranch(branch, ctx.config.branchPrefix)}.`);
}
