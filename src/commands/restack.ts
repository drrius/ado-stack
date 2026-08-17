import { targetBranchGoneMessage } from "../ado/errors.ts";
import {
  decodeStackProperties,
  encodeStackProperties,
  propertyPatches,
} from "../ado/properties.ts";
import { CliError } from "../errors/cli-error.ts";
import { stackOrder } from "../stack/graph.ts";
import {
  type PullRequestSnapshot,
  RestackConflictError,
  applyRestackStepToState,
  assertSafeRewrite,
  executeRestackStep,
  markStep,
  planRestack,
  resolveOntoSha,
} from "../stack/restack.ts";
import type { RestackPlanState, RestackStep, StackState } from "../state/schema.ts";
import {
  type AppContext,
  createAdoClient,
  fromRefsHeads,
  maybeAdoClient,
  refsHeads,
  requireState,
} from "./context.ts";

export async function restackCommand(
  ctx: AppContext,
  flags: Record<string, string | boolean>,
): Promise<void> {
  if (flags.abort === true) {
    await abortRestack(ctx);
    return;
  }
  if (flags.continue === true) {
    await continueRestack(ctx);
    return;
  }
  const state = await requireState(ctx);
  await ctx.git.requireCleanTrackedTree("restack");
  if (await ctx.git.rebaseInProgress()) {
    throw new CliError(
      "A Git rebase is already in progress.\n\nFinish it with `git rebase --continue` or `ado-stack restack --abort`.",
    );
  }
  await ctx.git.fetch(state.remoteName);
  const pullRequests = await loadSnapshots(ctx, state);
  const plan = await planRestack({ git: ctx.git, state, pullRequests });
  if (plan.steps.length === 0) {
    ctx.log.info("Stack is already up to date.");
    return;
  }
  await ctx.stateStore.writeRestackPlan(plan);
  await runPlan(ctx, state, plan);
}

async function continueRestack(ctx: AppContext): Promise<void> {
  const plan = await ctx.stateStore.readRestackPlan();
  if (!plan) {
    throw new CliError("No restack is in progress.");
  }
  if (await ctx.git.rebaseInProgress()) {
    throw new CliError(
      "Git rebase is still in progress.\n\nResolve conflicts, `git add` the files, run `git rebase --continue`, then `ado-stack restack --continue`.",
    );
  }
  const state = await requireState(ctx);
  const conflicted = plan.steps.find(
    (step) => step.status === "conflict" || step.status === "in-progress",
  );
  if (conflicted) {
    const tip = await ctx.git.getBranchTip(conflicted.branch);
    if (tip === conflicted.preRebaseTip) {
      throw new CliError(
        `Rebase of \`${conflicted.branch}\` did not complete. The branch tip is unchanged.\n\nFinish the rebase or run \`ado-stack restack --abort\`.`,
      );
    }
    const nextState = applyRestackStepToState(state, conflicted, tip);
    await pushRewritten(ctx, nextState, conflicted);
    await retargetIfNeeded(ctx, nextState, conflicted);
    await ctx.stateStore.write(nextState);
    const nextPlan = markStep(plan, conflicted.branch, "done");
    await ctx.stateStore.writeRestackPlan(nextPlan);
    await runPlan(ctx, nextState, nextPlan);
    return;
  }
  await runPlan(ctx, state, plan);
}

async function abortRestack(ctx: AppContext): Promise<void> {
  if (await ctx.git.rebaseInProgress()) {
    await ctx.git.abortRebase();
    ctx.log.info("Aborted the in-progress Git rebase.");
  }
  await ctx.stateStore.clearRestackPlan();
  ctx.log.info("Cleared the ado-stack restack plan. Branches already pushed were not rolled back.");
}

async function runPlan(
  ctx: AppContext,
  state: StackState,
  initialPlan: RestackPlanState,
): Promise<void> {
  let current = state;
  let plan = initialPlan;
  for (const step of plan.steps) {
    if (step.status === "done") {
      continue;
    }
    const live: RestackStep = {
      ...step,
      ontoSha: await resolveOntoSha(ctx.git, current, step.onto),
      preRebaseTip: await ctx.git.getBranchTip(step.branch),
      oldBase: current.branches[step.branch]?.lastRestackBase ?? step.oldBase,
    };
    await ctx.stateStore.writeRestackPlan(markStep(plan, step.branch, "in-progress"));
    try {
      current = await executeRestackStep({ git: ctx.git, state: current, step: live });
    } catch (error) {
      if (error instanceof RestackConflictError) {
        await ctx.stateStore.writeRestackPlan(markStep(plan, step.branch, "conflict"));
      }
      throw error;
    }
    await pushRewritten(ctx, current, live);
    await retargetIfNeeded(ctx, current, live);
    await ctx.stateStore.write(current);
    plan = markStep(plan, step.branch, "done");
    await ctx.stateStore.writeRestackPlan(plan);
    ctx.log.success(`Restacked ${step.branch} onto ${step.onto}`);
  }
  await ctx.stateStore.clearRestackPlan();
  ctx.log.info(`Stack restacked: ${stackOrder(current).join(" → ")}`);
}

async function pushRewritten(ctx: AppContext, state: StackState, step: RestackStep): Promise<void> {
  const record = state.branches[step.branch];
  if (!record) {
    return;
  }
  await assertSafeRewrite({
    git: ctx.git,
    state,
    branch: step.branch,
    remoteName: state.remoteName,
  });
  const exists = await ctx.git.remoteBranchExists(state.remoteName, step.branch);
  if (!exists) {
    await ctx.git.push(state.remoteName, step.branch, { setUpstream: true });
  } else {
    const expected = record.lastKnownRemoteTip ?? step.preRebaseTip;
    await ctx.git.forcePushWithLease({
      remote: state.remoteName,
      branch: step.branch,
      expectedRemoteSha: expected,
    });
  }
  const tip = await ctx.git.getBranchTip(step.branch);
  record.lastKnownRemoteTip = tip;
  record.lastLocalTip = tip;
}

async function retargetIfNeeded(
  ctx: AppContext,
  state: StackState,
  step: RestackStep,
): Promise<void> {
  if (!step.retargetPrTo) {
    return;
  }
  const record = state.branches[step.branch];
  if (!record?.pullRequestId) {
    return;
  }
  const ado = await maybeAdoClient(ctx, state);
  if (!ado) {
    ctx.log.warn(`Skipped PR retarget for ${step.branch}; Azure DevOps is unavailable.`);
    return;
  }
  const pr = await ado.getPullRequest(record.pullRequestId);
  if (pr.status !== "active") {
    throw new CliError(
      `Cannot retarget PR #${pr.pullRequestId} because it is ${pr.status}. Expected an active PR from \`${step.branch}\`.`,
    );
  }
  if (fromRefsHeads(pr.sourceRefName) !== step.branch) {
    throw new CliError(
      `Cannot retarget PR #${pr.pullRequestId}: source is ${fromRefsHeads(pr.sourceRefName)}, expected ${step.branch}.`,
    );
  }
  if (fromRefsHeads(pr.targetRefName) === step.retargetPrTo) {
    return;
  }
  try {
    await ado.updatePullRequest(pr.pullRequestId, { targetRefName: refsHeads(step.retargetPrTo) });
  } catch (error) {
    throw new CliError(targetBranchGoneMessage(step.retargetPrTo), { cause: error });
  }
  const previous = await ado.getPullRequestProperties(pr.pullRequestId);
  const existing = decodeStackProperties(previous);
  const stackId = state.stackId ?? existing?.stackId;
  if (stackId) {
    await ado.updatePullRequestProperties(
      pr.pullRequestId,
      propertyPatches(
        encodeStackProperties({
          version: existing?.version ?? "1",
          stackId,
          parent: step.retargetPrTo,
          branch: step.branch,
          lastRestackBase: record.lastRestackBase,
        }),
        previous,
      ),
    );
  }
  ctx.log.success(`PR #${pr.pullRequestId} ${step.branch} → ${step.retargetPrTo}`);
}

async function loadSnapshots(
  ctx: AppContext,
  state: StackState,
): Promise<Map<number, PullRequestSnapshot>> {
  const snapshots = new Map<number, PullRequestSnapshot>();
  let ado: Awaited<ReturnType<typeof createAdoClient>> | undefined;
  try {
    ado = await createAdoClient(ctx, state);
  } catch {
    ado = undefined;
  }
  if (!ado) {
    return snapshots;
  }
  for (const branch of stackOrder(state)) {
    const id = state.branches[branch]?.pullRequestId;
    if (id === undefined) {
      continue;
    }
    try {
      const pr = await ado.getPullRequest(id);
      snapshots.set(id, {
        id,
        status: pr.status,
        sourceBranch: fromRefsHeads(pr.sourceRefName),
        targetBranch: fromRefsHeads(pr.targetRefName),
      });
    } catch {
      ctx.log.debug(`Could not load PR #${id} during restack planning`);
    }
  }
  return snapshots;
}
