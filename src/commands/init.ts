import type { AdoClient } from "../ado/client.ts";
import { AdoError } from "../ado/errors.ts";
import { decodeStackProperties } from "../ado/properties.ts";
import { parseAzureDevOpsRemote } from "../ado/remote.ts";
import { CliError, isCliError } from "../errors/cli-error.ts";
import { hydrateForestTips } from "../stack/hydrate.ts";
import { pruneUntracked, untrackedNames } from "../stack/membership.ts";
import {
  type ReconstructPullRequest,
  formatReconstructConflicts,
  reconstructForest,
} from "../stack/reconstruct.ts";
import type { StackState } from "../state/schema.ts";
import { logNext } from "../ui/next.ts";
import { type AppContext, createAdoClient, detectRemote, fromRefsHeads } from "./context.ts";
import { reconcileCompletedMerges } from "./reconcile.ts";

export async function initCommand(
  ctx: AppContext,
  flags: Record<string, string | boolean>,
): Promise<void> {
  const remote = await detectRemote(ctx);
  const parsed = remote ? parseAzureDevOpsRemote(remote.url) : undefined;
  const organizationUrl =
    stringFlag(flags.organization) ?? ctx.config.organization ?? parsed?.organizationUrl;
  const project = stringFlag(flags.project) ?? ctx.config.project ?? parsed?.project;
  const repository = stringFlag(flags.repository) ?? ctx.config.repository ?? parsed?.repository;
  const remoteName = stringFlag(flags.remote) ?? remote?.remoteName ?? ctx.config.remoteName;
  let defaultBranch =
    stringFlag(flags["default-branch"]) ??
    ctx.config.defaultBranch ??
    (await ctx.git.defaultRemoteHead(remoteName));

  if (!organizationUrl || !project || !repository) {
    throw new CliError(
      "Could not detect an Azure DevOps remote.\n\nPass `--organization`, `--project`, and `--repository`, or set them with `ado-stack config`.",
    );
  }
  const organizationName =
    parsed?.organization ?? organizationUrl.replace(/\/+$/, "").split("/").pop() ?? organizationUrl;
  if (!defaultBranch) {
    defaultBranch = "main";
    ctx.log.warn(
      "Could not detect a default branch. Using `main`. Set it with `ado-stack config set defaultBranch <name>`.",
    );
  }

  let repositoryId: string | undefined;
  let state: StackState = {
    version: 1,
    organization: organizationUrl,
    organizationName,
    project,
    repository,
    defaultBranch,
    remoteName,
    branches: {},
  };

  const existing = await ctx.stateStore.read();
  if (existing) {
    state = {
      ...existing,
      organization: organizationUrl,
      organizationName,
      project,
      repository,
      defaultBranch,
      remoteName,
    };
  }

  let adoMetadataLoaded = false;
  let adoMetadataError: string | undefined;
  let adoMetadataCause: unknown;
  let rebuiltState: StackState | undefined;
  try {
    const ado = await createAdoClient(ctx, state);
    const repo = await ado.getRepository();
    repositoryId = repo.id;
    if (repo.defaultBranch) {
      defaultBranch = fromRefsHeads(repo.defaultBranch);
    }
    state.repositoryId = repositoryId;
    state.defaultBranch = defaultBranch;
    const rebuilt = await reconstructFromAdo(ctx, ado, state);
    adoMetadataLoaded = true;
    if (rebuilt.ok) {
      rebuiltState = rebuilt.state;
    } else if (!rebuilt.conflicts.some((conflict) => conflict.kind === "empty")) {
      ctx.log.warn(formatReconstructConflicts(rebuilt.conflicts));
      ctx.log.warn("Left local stack state unchanged instead of guessing parentage.");
    }
  } catch (error) {
    adoMetadataCause = error;
    adoMetadataError = error instanceof Error ? error.message : String(error);
  }

  if (rebuiltState) {
    state = await hydrateForestTips(ctx.git, rebuiltState);
    ctx.log.success("Rebuilt stack state from Azure DevOps pull request metadata.");
    state = await reconcileCompletedMerges(ctx, state);
  }

  await ctx.stateStore.write(state);
  const layers = Object.keys(state.branches).length;
  const repositoryLabel = `${state.organizationName}/${state.project}/${state.repository}`;
  const stackDetails = `default branch ${state.defaultBranch}${layers ? `, ${layers} tracked branches` : ""}`;
  if (adoMetadataLoaded) {
    ctx.log.info(`Initialized ado-stack for ${repositoryLabel} (${stackDetails}).`);
    return;
  }
  const next = nextStepForInitFailure(adoMetadataCause);
  ctx.log.info(
    `Wrote local ado-stack state for ${repositoryLabel} (${stackDetails}; Azure DevOps not connected).`,
  );
  ctx.log.warn(
    `Azure DevOps metadata was not loaded: ${adoMetadataError ?? "Azure DevOps is unavailable"}.`,
  );
  logNext(ctx.log, next);
}

function nextStepForInitFailure(error: unknown): string {
  if (error instanceof AdoError) {
    switch (error.kind) {
      case "unauthenticated":
      case "expired":
        return "ado-stack auth login";
      case "forbidden":
        return "ado-stack auth login";
      case "not-found":
        return "ado-stack config list";
      case "bad-request":
      case "conflict":
      case "rate-limited":
      case "server":
      case "unknown":
        return "ado-stack init";
      default: {
        const _exhaustive: never = error.kind;
        return String(_exhaustive);
      }
    }
  }
  if (isCliError(error) && error.message.includes("No Azure DevOps credentials were found")) {
    return "ado-stack auth login";
  }
  return "ado-stack init";
}

export async function reconstructFromAdo(
  ctx: AppContext,
  ado: AdoClient,
  base: StackState,
): Promise<ReturnType<typeof reconstructForest>> {
  const prs = await ado.listPullRequests({ status: "all" });
  const pullRequests: ReconstructPullRequest[] = [];
  for (const pr of prs) {
    let properties: ReconstructPullRequest["properties"];
    try {
      properties = decodeStackProperties(await ado.getPullRequestProperties(pr.pullRequestId));
    } catch {
      properties = undefined;
    }
    pullRequests.push({
      id: pr.pullRequestId,
      status: pr.status,
      sourceBranch: fromRefsHeads(pr.sourceRefName),
      targetBranch: fromRefsHeads(pr.targetRefName),
      lastMergeSourceCommit: pr.lastMergeSourceCommit?.commitId,
      properties,
    });
  }
  const localExisting = new Set<string>();
  const remoteExisting = new Set<string>();
  for (const name of untrackedNames(base)) {
    if (await ctx.git.branchExists(name)) {
      localExisting.add(name);
    }
    if (await ctx.git.remoteBranchExists(base.remoteName, name)) {
      remoteExisting.add(name);
    }
  }
  pruneUntracked(base, {
    pullRequests: pullRequests.map((pr) => ({ sourceBranch: pr.sourceBranch, status: pr.status })),
    branchExists: (name) => localExisting.has(name),
    remoteBranchExists: (name) => remoteExisting.has(name),
  });
  const result = reconstructForest({ base, pullRequests });
  for (const skip of result.skipped) {
    ctx.log.warn(`Skipped PR #${skip.pullRequestId} \`${skip.sourceBranch}\`: ${skip.reason}.`);
  }
  const untrackedSkipCount = result.skipped.filter((skip) => skip.reason === "untracked").length;
  if (untrackedSkipCount > 0) {
    ctx.log.info(
      `Skipped ${untrackedSkipCount} untracked pull request${untrackedSkipCount === 1 ? "" : "s"}.`,
    );
  }
  if (result.ok) {
    ctx.log.verbose(
      `Adopted ${Object.keys(result.state.branches).length} branches from pull request targets.`,
    );
  } else {
    ctx.log.verbose(formatReconstructConflicts(result.conflicts));
  }
  return result;
}

function stringFlag(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
