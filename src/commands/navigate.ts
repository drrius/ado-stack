import { CliError } from "../errors/cli-error.ts";
import { childrenOf } from "../stack/graph.ts";
import { looksLikePrNumber, parsePrNumber, resolveBranchArg } from "../stack/names.ts";
import { downBranch, upBranch } from "../stack/navigation.ts";
import { formatBranch } from "../ui/format.ts";
import { type AppContext, createAdoClient, fromRefsHeads, requireState } from "./context.ts";

export async function upCommand(ctx: AppContext, args: string[]): Promise<void> {
  await move(
    ctx,
    (state, current) => {
      const requested = args[0]
        ? resolveBranchArg(args[0], {
            prefix: ctx.config.branchPrefix,
            known: childrenOf(state, current),
          })
        : undefined;
      return upBranch(state, current, requested);
    },
    "move up the stack",
  );
}

export async function downCommand(ctx: AppContext): Promise<void> {
  await move(ctx, (state, current) => downBranch(state, current), "move down the stack");
}

export async function checkoutCommand(ctx: AppContext, args: string[]): Promise<void> {
  const target = args[0];
  if (!target) {
    throw new CliError("Usage: ado-stack checkout <branch-or-pr>");
  }
  const state = await requireState(ctx);
  await ctx.git.requireCleanTrackedTree("check out a branch");
  if (looksLikePrNumber(target)) {
    const id = parsePrNumber(target);
    const ado = await createAdoClient(ctx, state);
    const pr = await ado.getPullRequest(id);
    const branch = fromRefsHeads(pr.sourceRefName);
    await ctx.git.fetch(state.remoteName);
    if (!(await ctx.git.branchExists(branch))) {
      if (!(await ctx.git.remoteBranchExists(state.remoteName, branch))) {
        throw new CliError(
          `PR #${id} source branch \`${branch}\` is not available locally or on ${state.remoteName}.`,
        );
      }
      await ctx.git.createBranch(branch, `${state.remoteName}/${branch}`);
    }
    await ctx.git.checkout(branch);
    ctx.log.success(`Checked out ${formatBranch(branch, ctx.config.branchPrefix)} (PR #${id}).`);
    return;
  }
  const known = [state.defaultBranch, ...Object.keys(state.branches)];
  const branch = resolveBranchArg(target, { prefix: ctx.config.branchPrefix, known });
  if (!(await ctx.git.branchExists(branch))) {
    await ctx.git.fetch(state.remoteName);
    if (await ctx.git.remoteBranchExists(state.remoteName, branch)) {
      await ctx.git.createBranch(branch, `${state.remoteName}/${branch}`);
    } else {
      throw new CliError(`Branch \`${branch}\` does not exist locally or on ${state.remoteName}.`);
    }
  }
  await ctx.git.checkout(branch);
  ctx.log.success(`Checked out ${formatBranch(branch, ctx.config.branchPrefix)}.`);
}

async function move(
  ctx: AppContext,
  pick: (state: Awaited<ReturnType<typeof requireState>>, current: string) => string,
  action: string,
): Promise<void> {
  const state = await requireState(ctx);
  const current = await ctx.git.currentBranch();
  if (!current) {
    throw new CliError("HEAD is detached. Check out a stack branch first.");
  }
  await ctx.git.requireCleanTrackedTree(action);
  const next = pick(state, current);
  await ctx.git.checkout(next);
  ctx.log.success(`Checked out ${formatBranch(next, ctx.config.branchPrefix)}.`);
}
