import { hydrateForestTips } from "../stack/hydrate.ts";
import { formatReconstructConflicts } from "../stack/reconstruct.ts";
import { type AppContext, createAdoClient, requireState } from "./context.ts";
import { reconstructFromAdo } from "./init.ts";
import { reconcileCompletedMerges } from "./reconcile.ts";

export async function repairCommand(ctx: AppContext): Promise<void> {
  const state = await requireState(ctx);
  const before = JSON.stringify(state);
  const ado = await createAdoClient(ctx, state);
  const rebuilt = await reconstructFromAdo(ctx, ado, state);
  if (!rebuilt.ok) {
    if (JSON.stringify(state) !== before) {
      await ctx.stateStore.write(state);
    }
    ctx.log.warn(
      `${formatReconstructConflicts(rebuilt.conflicts)}\n\nLocal state was left unchanged.`,
    );
    return;
  }
  const hydrated = await hydrateForestTips(ctx.git, rebuilt.state);
  const reconciled = await reconcileCompletedMerges(ctx, hydrated);
  const after = JSON.stringify(reconciled);
  if (after === before) {
    ctx.log.success("Local stack state already matches Azure DevOps parentage.");
    return;
  }
  await ctx.stateStore.write(reconciled);
  ctx.log.success("Rebuilt local stack state from Azure DevOps metadata.");
}
