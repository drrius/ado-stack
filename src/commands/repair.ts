import { formatReconstructConflicts } from "../stack/reconstruct.ts";
import { type AppContext, createAdoClient, requireState } from "./context.ts";
import { reconstructFromAdo } from "./init.ts";

export async function repairCommand(ctx: AppContext): Promise<void> {
  const state = await requireState(ctx);
  const before = JSON.stringify(state);
  const ado = await createAdoClient(ctx, state);
  const rebuilt = await reconstructFromAdo(ctx, ado, state);
  if (!rebuilt.ok) {
    ctx.log.warn(
      `${formatReconstructConflicts(rebuilt.conflicts)}\n\nLocal state was left unchanged.`,
    );
    return;
  }
  for (const [name, branch] of Object.entries(rebuilt.state.branches)) {
    if (await ctx.git.branchExists(name)) {
      branch.lastLocalTip = await ctx.git.getBranchTip(name);
      const parentRef =
        branch.parent === rebuilt.state.defaultBranch || (await ctx.git.branchExists(branch.parent))
          ? branch.parent
          : undefined;
      if (parentRef) {
        const mergeBase = await ctx.git.mergeBase(parentRef, name);
        if (mergeBase) {
          branch.lastRestackBase = mergeBase;
        }
      }
    }
    if ((await ctx.git.remoteBranchExists(state.remoteName, name)) && branch.lastKnownRemoteTip) {
      const actual = await ctx.git.getBranchTip(`${state.remoteName}/${name}`);
      if (actual === branch.lastLocalTip) {
        branch.lastKnownRemoteTip = actual;
      }
    }
  }
  const after = JSON.stringify(rebuilt.state);
  if (after === before) {
    ctx.log.success("Local stack state already matches Azure DevOps parentage.");
    return;
  }
  await ctx.stateStore.write(rebuilt.state);
  ctx.log.success("Rebuilt local stack state from Azure DevOps metadata.");
}
