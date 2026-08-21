import {
  assertDescriptionLimit,
  generateStackBlock,
  humanDescription,
  upsertManagedSection,
} from "../ado/description.ts";
import { encodeStackProperties, propertyPatches } from "../ado/properties.ts";
import type { AdoPullRequest } from "../ado/types.ts";
import { CliError } from "../errors/cli-error.ts";
import { isStandaloneBranch, stackOrder, stackScope } from "../stack/graph.ts";
import { assertSafeRewrite } from "../stack/restack.ts";
import type { StackState } from "../state/schema.ts";
import { formatBranch, pullRequestWebUrl } from "../ui/format.ts";
import { logNext } from "../ui/next.ts";
import { type AppContext, createAdoClient, refsHeads, requireState } from "./context.ts";

export async function submitCommand(
  ctx: AppContext,
  flags: Record<string, string | boolean>,
): Promise<void> {
  const state = await requireState(ctx);
  const current = await ctx.git.currentBranch();
  const order = submitOrder(state, { all: flags.all === true, current });
  if (order.length === 0) {
    throw new CliError("The stack is empty. Create a branch with `ado-stack create <name>`.");
  }
  await ctx.git.requireCleanTrackedTree("submit the stack");
  const ado = await createAdoClient(ctx, state);
  ctx.log.info(
    order.length === 1 ? "Submitting 1 pull request..." : `Submitting ${order.length}-PR stack...`,
  );
  ctx.log.verbose(`fetch ${state.remoteName}`);
  await ctx.git.fetch(state.remoteName);

  if (!state.stackId) {
    state.stackId = crypto.randomUUID();
  }

  const explicitTitle = typeof flags.title === "string" ? flags.title : undefined;
  const submitted: Array<{ branch: string; pr: AdoPullRequest }> = [];

  for (const branch of order) {
    const record = state.branches[branch];
    if (!record) {
      continue;
    }
    const localTip = await ctx.git.getBranchTip(branch);
    record.lastLocalTip = localTip;
    const remoteExists = await ctx.git.remoteBranchExists(state.remoteName, branch);
    const needsPush =
      !remoteExists || (await ctx.git.getBranchTip(`${state.remoteName}/${branch}`)) !== localTip;
    if (needsPush) {
      if (!remoteExists) {
        await ctx.git.push(state.remoteName, branch, { setUpstream: true });
      } else {
        const remoteTip = await ctx.git.getBranchTip(`${state.remoteName}/${branch}`);
        if (await ctx.git.isAncestor(remoteTip, localTip)) {
          await ctx.git.push(state.remoteName, branch, { setUpstream: true });
        } else {
          await assertSafeRewrite({
            git: ctx.git,
            state,
            branch,
            remoteName: state.remoteName,
          });
          await ctx.git.forcePushWithLease({
            remote: state.remoteName,
            branch,
            expectedRemoteSha: record.lastKnownRemoteTip ?? remoteTip,
          });
        }
      }
      ctx.log.success(`${formatBranch(branch, ctx.config.branchPrefix)} pushed`);
    } else {
      ctx.log.verbose(
        `${formatBranch(branch, ctx.config.branchPrefix)} already up to date on ${state.remoteName}`,
      );
    }
    record.lastKnownRemoteTip = localTip;
    record.lastSubmittedTip = localTip;

    let pr =
      record.pullRequestId !== undefined
        ? await ado.getPullRequest(record.pullRequestId).catch(() => undefined)
        : undefined;
    if (!pr || pr.status !== "active" || pr.sourceRefName !== refsHeads(branch)) {
      pr = await ado.findActivePullRequestBySource(branch);
    }
    if (!pr) {
      const title = await defaultTitle({
        git: ctx.git,
        branch,
        recordBase: record.lastRestackBase,
        explicitTitle: current === branch ? explicitTitle : undefined,
        prefix: ctx.config.branchPrefix,
      });
      pr = await ado.createPullRequest({
        sourceRefName: refsHeads(branch),
        targetRefName: refsHeads(record.parent),
        title,
        description: "",
      });
    } else if (pr.targetRefName !== refsHeads(record.parent) && pr.status === "active") {
      pr = await ado.updatePullRequest(pr.pullRequestId, {
        targetRefName: refsHeads(record.parent),
      });
    }
    record.pullRequestId = pr.pullRequestId;
    submitted.push({ branch, pr });
    ctx.log.success(
      `PR #${pr.pullRequestId} ${formatBranch(branch, ctx.config.branchPrefix)} → ${formatBranch(record.parent, ctx.config.branchPrefix)} ${pullRequestWebUrl(state, pr.pullRequestId)}`,
    );
  }

  const items = submitted.map(({ branch, pr }) => ({
    id: pr.pullRequestId,
    title: pr.title,
    current: false,
    branch,
    parent: state.branches[branch]?.parent ?? state.defaultBranch,
  }));

  for (const { branch, pr } of submitted) {
    const record = state.branches[branch];
    if (!record) {
      continue;
    }
    const full = await ado.getPullRequest(pr.pullRequestId);
    const existing = full.description ?? "";
    const tree = stackScope(state, branch);
    const description = isStandaloneBranch(state, branch)
      ? humanDescription(existing)
      : upsertManagedSection(
          existing,
          generateStackBlock(
            items
              .filter((item) => item.branch !== undefined && tree.has(item.branch))
              .map((item) => ({
                ...item,
                current: item.branch === branch,
              })),
          ),
        );
    assertDescriptionLimit(description);
    if (description !== (full.description ?? "")) {
      await ado.updatePullRequest(pr.pullRequestId, { description });
    }
    const previous = await ado.getPullRequestProperties(pr.pullRequestId);
    const nextProps = encodeStackProperties({
      version: "1",
      stackId: state.stackId ?? "",
      parent: record.parent,
      branch,
      lastRestackBase: record.lastRestackBase,
    });
    await ado.updatePullRequestProperties(pr.pullRequestId, propertyPatches(nextProps, previous));
  }

  await ctx.stateStore.write(state);
  ctx.log.info("");
  ctx.log.info(
    `Submitted ${submitted.length} ${
      submitted.length === 1 ? "pull request" : "pull requests"
    } in parent-before-child order: ${submitted.map(({ pr }) => `#${pr.pullRequestId}`).join(", ")}`,
  );
  logNext(ctx.log, "review and merge the bottom PR in Azure DevOps, then ado-stack restack");
}

function submitOrder(
  state: StackState,
  options: { all: boolean; current: string | undefined },
): string[] {
  const forest = stackOrder(state);
  if (options.all) {
    return forest;
  }
  if (options.current === undefined || !state.branches[options.current]) {
    throw new CliError(
      "Check out a tracked stack branch, or pass `--all` to submit every tracked stack.",
    );
  }
  const scope = stackScope(state, options.current);
  return forest.filter((branch) => scope.has(branch));
}

async function defaultTitle(options: {
  git: {
    getCommitsBetween: (from: string, to: string) => Promise<Array<{ subject: string }>>;
    getCommit: (sha: string) => Promise<{ subject: string }>;
  };
  branch: string;
  recordBase: string;
  explicitTitle?: string;
  prefix: string;
}): Promise<string> {
  if (options.explicitTitle) {
    return options.explicitTitle;
  }
  const commits = await options.git.getCommitsBetween(options.recordBase, options.branch);
  const last = commits[commits.length - 1];
  if (last?.subject) {
    return last.subject;
  }
  try {
    return (await options.git.getCommit(options.branch)).subject;
  } catch {
    return formatBranch(options.branch, options.prefix);
  }
}
