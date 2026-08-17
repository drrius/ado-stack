import { type AppContext, createAdoClient, requireState } from "./context.ts";
import { reconstructFromAdo } from "./init.ts";

export async function repairCommand(ctx: AppContext): Promise<void> {
  const state = await requireState(ctx);
  const ado = await createAdoClient(ctx, state);
  const rebuilt = await reconstructFromAdo(ctx, ado, state);
  if (!rebuilt) {
    ctx.log.warn(
      "Could not rebuild an unambiguous stack from Azure DevOps metadata. Local state was left unchanged.",
    );
    return;
  }
  for (const [name, branch] of Object.entries(rebuilt.branches)) {
    if (await ctx.git.branchExists(name)) {
      branch.lastLocalTip = await ctx.git.getBranchTip(name);
    }
    if ((await ctx.git.remoteBranchExists(state.remoteName, name)) && branch.lastKnownRemoteTip) {
      const actual = await ctx.git.getBranchTip(`${state.remoteName}/${name}`);
      if (actual === branch.lastLocalTip) {
        branch.lastKnownRemoteTip = actual;
      }
    }
  }
  await ctx.stateStore.write(rebuilt);
  ctx.log.success("Rebuilt local stack state from Azure DevOps metadata.");
}
