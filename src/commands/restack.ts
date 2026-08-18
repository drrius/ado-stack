import { CliError } from "../errors/cli-error.ts";
import { GitRepo } from "../git/git.ts";
import { sameWorktreePath } from "../git/worktree.ts";
import { stackOrder } from "../stack/graph.ts";
import {
  type PullRequestSnapshot,
  RestackConflictError,
  applyRestackStepToState,
  assertSafeRewrite,
  branchWasSubmitted,
  conflictScope,
  executeRestackStep,
  markStep,
  planRestack,
  resolveOntoSha,
} from "../stack/restack.ts";
import { resolveRestackWorktrees, restackRebaseGit } from "../stack/worktrees.ts";
import type { RestackPlanState, RestackStep, StackState } from "../state/schema.ts";
import { formatBranch } from "../ui/format.ts";
import { createLogger } from "../ui/log.ts";
import { type AppContext, requireState, resolveAdoAccess } from "./context.ts";
import {
  loadTrackedSnapshots,
  requireCompleteSnapshots,
  retargetStackPullRequest,
} from "./pull-requests.ts";
import { reconcileCompletedMerges } from "./reconcile.ts";
import {
  type RestackReporter,
  type RestackStatusReport,
  conflictBranchOf,
  jsonRestackReporter,
  serializeRestackEvent,
} from "./restack-events.ts";

export async function previewRestack(ctx: AppContext): Promise<RestackPlanState> {
  const state = await requireState(ctx);
  await ctx.git.fetch(state.remoteName);
  const reconciled = await reconcileCompletedMerges(ctx, state);
  const pullRequests = await loadSnapshots(ctx, reconciled);
  return planRestack({ git: ctx.git, state: reconciled, pullRequests });
}

export async function restackCommand(
  ctx: AppContext,
  flags: Record<string, string | boolean>,
): Promise<void> {
  const json = flags.json === true;
  if (flags.status === true) {
    if (flags.abort === true || flags.continue === true) {
      throw new CliError("Use --status alone. It only reads state.");
    }
    await restackStatus(ctx, { json });
    return;
  }
  const runCtx = json ? withStderrLogger(ctx) : ctx;
  const reporter = json
    ? jsonRestackReporter((line) => process.stdout.write(`${line}\n`))
    : humanRestackReporter(runCtx);
  try {
    await runRestackCommand(runCtx, flags, reporter);
  } catch (error) {
    if (json) {
      await emitFailureEvent(runCtx, error);
    }
    throw error;
  }
}

function withStderrLogger(ctx: AppContext): AppContext {
  return {
    ...ctx,
    log: createLogger({
      verbose: ctx.verbose,
      debug: ctx.debug,
      stdout: (line) => console.error(line),
    }),
  };
}

function humanRestackReporter(ctx: AppContext): RestackReporter {
  const prefix = ctx.config.branchPrefix;
  return {
    plan: () => {},
    upToDate: () => ctx.log.info("Stack is already up to date."),
    stepStart: () => {},
    stepDone: (step) =>
      ctx.log.success(
        `Restacked ${formatBranch(step.branch, prefix)} onto ${formatBranch(step.onto, prefix)}`,
      ),
    done: (branches) =>
      ctx.log.info(
        `Stack restacked: ${branches.map((branch) => formatBranch(branch, prefix)).join(", ")}`,
      ),
    aborted: () => {},
  };
}

async function emitFailureEvent(ctx: AppContext, error: unknown): Promise<void> {
  if (error instanceof RestackConflictError) {
    const worktreePath = error.worktreePath ?? (await safeToplevel(ctx.git));
    const files = await safeConflictedFiles(
      error.worktreePath === undefined ? ctx.git : new GitRepo(error.worktreePath),
    );
    process.stdout.write(
      `${serializeRestackEvent({
        event: "conflict",
        branch: error.branch,
        worktreePath,
        files,
        blocked: error.blocked,
        untouched: error.untouched,
      })}\n`,
    );
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`${serializeRestackEvent({ event: "error", message })}\n`);
}

async function safeToplevel(git: AppContext["git"]): Promise<string> {
  try {
    return await git.toplevel();
  } catch {
    return git.cwd;
  }
}

async function safeConflictedFiles(git: GitRepo): Promise<string[]> {
  try {
    return await git.conflictedFiles();
  } catch {
    return [];
  }
}

export async function restackStatus(
  ctx: AppContext,
  options: { json: boolean },
): Promise<RestackStatusReport> {
  const plan = (await ctx.stateStore.readRestackPlan()) ?? null;
  const pending = plan
    ? plan.steps.filter((step) => step.status !== "done").map((step) => step.branch)
    : [];
  const rebaseGit = (await restackRebaseGit(ctx.git, pending)) ?? ctx.git;
  const inProgress = await rebaseGit.rebaseInProgress();
  const report: RestackStatusReport = {
    plan,
    conflictBranch: conflictBranchOf(plan),
    rebase: inProgress
      ? {
          inProgress: true,
          worktreePath: await safeToplevel(rebaseGit),
          conflictedFiles: await safeConflictedFiles(rebaseGit),
        }
      : { inProgress: false },
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return report;
  }
  if (!report.plan) {
    ctx.log.info("No restack is in progress.");
    return report;
  }
  for (const step of report.plan.steps) {
    ctx.log.info(`${step.status.padEnd(11)} ${step.branch} → ${step.onto}`);
  }
  if (report.rebase.inProgress) {
    ctx.log.info(`Git rebase in progress at ${report.rebase.worktreePath}`);
    for (const file of report.rebase.conflictedFiles) {
      ctx.log.info(`  conflict: ${file}`);
    }
  }
  return report;
}

async function runRestackCommand(
  ctx: AppContext,
  flags: Record<string, string | boolean>,
  reporter: RestackReporter,
): Promise<void> {
  if (flags.abort === true) {
    await abortRestack(ctx, reporter);
    return;
  }
  if (flags.continue === true) {
    await continueRestack(ctx, reporter);
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
  const reconciled = await reconcileCompletedMerges(ctx, state);
  const pullRequests = await loadSnapshots(ctx, reconciled);
  const plan = await planRestack({ git: ctx.git, state: reconciled, pullRequests });
  if (plan.steps.length === 0) {
    reporter.upToDate();
    return;
  }
  reporter.plan(plan);
  await resolveRestackWorktrees(
    ctx.git,
    plan.steps.map((step) => step.branch),
  );
  await ctx.stateStore.writeRestackPlan(plan);
  await restoreCheckoutAfter(ctx.git, () => runPlan(ctx, reconciled, plan, reporter));
}

async function continueRestack(ctx: AppContext, reporter: RestackReporter): Promise<void> {
  const plan = await ctx.stateStore.readRestackPlan();
  if (!plan) {
    throw new CliError("No restack is in progress.");
  }
  const rebaseGit =
    (await restackRebaseGit(
      ctx.git,
      plan.steps.filter((step) => step.status !== "done").map((step) => step.branch),
    )) ?? ctx.git;
  if (await rebaseGit.rebaseInProgress()) {
    const where = sameWorktreePath(rebaseGit.cwd, ctx.git.cwd)
      ? ""
      : `\n\nThe rebase is in the worktree at:\n  ${rebaseGit.cwd}`;
    throw new CliError(
      `Git rebase is still in progress.${where}\n\nResolve conflicts, \`git add\` the files, run \`git rebase --continue\`, then \`ado-stack restack --continue\`.`,
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
    reporter.stepDone(conflicted);
    await restoreCheckoutAfter(ctx.git, () => runPlan(ctx, nextState, nextPlan, reporter));
    return;
  }
  await restoreCheckoutAfter(ctx.git, () => runPlan(ctx, state, plan, reporter));
}

async function abortRestack(ctx: AppContext, reporter: RestackReporter): Promise<void> {
  const plan = await ctx.stateStore.readRestackPlan();
  const branches = plan
    ? plan.steps.filter((step) => step.status !== "done").map((step) => step.branch)
    : [];
  const rebaseGit = (await restackRebaseGit(ctx.git, branches)) ?? ctx.git;
  if (await rebaseGit.rebaseInProgress()) {
    await rebaseGit.abortRebase();
    ctx.log.info("Aborted the in-progress Git rebase.");
  }
  await ctx.stateStore.clearRestackPlan();
  ctx.log.info("Cleared the ado-stack restack plan. Branches already pushed were not rolled back.");
  reporter.aborted();
}

type CheckoutSnapshot = {
  branch: string | undefined;
  head: string;
};

async function snapshotCheckout(git: AppContext["git"]): Promise<CheckoutSnapshot> {
  return {
    branch: await git.currentBranch(),
    head: await git.getBranchTip("HEAD"),
  };
}

async function restoreCheckout(git: AppContext["git"], start: CheckoutSnapshot): Promise<void> {
  if (await git.rebaseInProgress()) {
    return;
  }
  const branch = await git.currentBranch();
  if (start.branch !== undefined) {
    if (branch !== start.branch) {
      await git.checkout(start.branch);
    }
    return;
  }
  const head = await git.getBranchTip("HEAD");
  if (head !== start.head) {
    await git.run(["checkout", "--detach", start.head]);
  }
}

async function restoreCheckoutAfter(
  git: AppContext["git"],
  action: () => Promise<void>,
): Promise<void> {
  const start = await snapshotCheckout(git);
  try {
    await action();
  } catch (error) {
    await restoreCheckout(git, start);
    throw error;
  }
  await restoreCheckout(git, start);
}

async function runPlan(
  ctx: AppContext,
  state: StackState,
  initialPlan: RestackPlanState,
  reporter: RestackReporter,
): Promise<void> {
  const pending = initialPlan.steps
    .filter((step) => step.status !== "done")
    .map((step) => step.branch);
  const sites = await resolveRestackWorktrees(ctx.git, pending);
  const currentPath = await ctx.git.toplevel();
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
    plan = {
      ...plan,
      steps: plan.steps.map((item) =>
        item.branch === live.branch ? { ...live, status: "in-progress" } : item,
      ),
    };
    await ctx.stateStore.writeRestackPlan(plan);
    reporter.stepStart(live);
    const site = sites.get(live.branch) ?? currentPath;
    const rebaseGit = sameWorktreePath(site, currentPath) ? ctx.git : new GitRepo(site);
    try {
      current = await executeRestackStep({
        git: ctx.git,
        state: current,
        step: live,
        rebaseGit,
      });
    } catch (error) {
      if (error instanceof RestackConflictError) {
        await ctx.stateStore.writeRestackPlan(markStep(plan, step.branch, "conflict"));
        const scope = conflictScope(current, plan, step.branch);
        throw new RestackConflictError(error.branch, error, {
          ...scope,
          worktreePath: error.worktreePath,
        });
      }
      throw error;
    }
    await pushRewritten(ctx, current, live);
    await retargetIfNeeded(ctx, current, live);
    await ctx.stateStore.write(current);
    plan = markStep(plan, step.branch, "done");
    await ctx.stateStore.writeRestackPlan(plan);
    reporter.stepDone(live);
  }
  await ctx.stateStore.clearRestackPlan();
  reporter.done(stackOrder(current));
}

async function pushRewritten(ctx: AppContext, state: StackState, step: RestackStep): Promise<void> {
  const record = state.branches[step.branch];
  if (!record || !branchWasSubmitted(record)) {
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
  const access = await resolveAdoAccess(ctx, state);
  if (access.status === "unavailable") {
    throw new CliError(
      `${access.message}\n\nAzure DevOps access is required to retarget pull requests safely during restack.`,
    );
  }
  const didRetarget = await retargetStackPullRequest({
    ado: access.client,
    state,
    branch: step.branch,
    pullRequestId: record.pullRequestId,
    target: step.retargetPrTo,
  });
  if (!didRetarget) {
    return;
  }
  ctx.log.success(
    `PR #${record.pullRequestId} ${formatBranch(step.branch, ctx.config.branchPrefix)} → ${formatBranch(step.retargetPrTo, ctx.config.branchPrefix)}`,
  );
}

async function loadSnapshots(
  ctx: AppContext,
  state: StackState,
): Promise<Map<number, PullRequestSnapshot>> {
  const branches = stackOrder(state);
  const pullRequestIds = branches.flatMap((branch) => {
    const id = state.branches[branch]?.pullRequestId;
    return id === undefined ? [] : [id];
  });
  const access = await resolveAdoAccess(ctx, state);
  if (access.status === "unavailable") {
    if (pullRequestIds.length === 0) {
      ctx.log.debug(`${access.message} Restack has no pull request state to resolve.`);
      return new Map();
    }
    ctx.log.warn(access.message);
    throw new CliError(
      "Azure DevOps authentication is required to restack safely after merges.\n\nRun `ado-stack auth login`, then retry `ado-stack restack`.",
    );
  }
  return requireCompleteSnapshots(await loadTrackedSnapshots(access.client, state));
}
