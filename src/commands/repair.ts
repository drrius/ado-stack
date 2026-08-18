import { hydrateForestTips } from "../stack/hydrate.ts";
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
  await hydrateForestTips(ctx.git, rebuilt.state);
  const after = JSON.stringify(rebuilt.state);
  if (after === before) {
    ctx.log.success("Local stack state already matches Azure DevOps parentage.");
    return;
  }
  await ctx.stateStore.write(rebuilt.state);
  ctx.log.success("Rebuilt local stack state from Azure DevOps metadata.");
}
