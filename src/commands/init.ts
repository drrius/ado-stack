import type { AdoClient } from "../ado/client.ts";
import { decodeStackProperties } from "../ado/properties.ts";
import { parseAzureDevOpsRemote } from "../ado/remote.ts";
import type { AdoPullRequest } from "../ado/types.ts";
import { CliError } from "../errors/cli-error.ts";
import { stackOrder } from "../stack/graph.ts";
import type { StackState } from "../state/schema.ts";
import { logNext } from "../ui/next.ts";
import { type AppContext, createAdoClient, detectRemote, fromRefsHeads } from "./context.ts";

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
    if (rebuilt) {
      state = rebuilt;
      ctx.log.success("Rebuilt stack state from Azure DevOps pull request metadata.");
    }
  } catch (error) {
    adoMetadataError = error instanceof Error ? error.message : String(error);
  }

  await ctx.stateStore.write(state);
  const layers = Object.keys(state.branches).length;
  const repositoryLabel = `${state.organizationName}/${state.project}/${state.repository}`;
  const stackDetails = `default branch ${state.defaultBranch}${layers ? `, ${layers} tracked branches` : ""}`;
  if (adoMetadataLoaded) {
    ctx.log.info(`Initialized ado-stack for ${repositoryLabel} (${stackDetails}).`);
    return;
  }
  ctx.log.info(
    `Wrote local ado-stack state for ${repositoryLabel} (${stackDetails}; Azure DevOps not connected).`,
  );
  ctx.log.warn(
    `Azure DevOps metadata was not loaded: ${adoMetadataError ?? "Azure DevOps is unavailable"}. Run \`ado-stack init\` again after login.`,
  );
  logNext(ctx.log, "ado-stack auth login");
}

export async function reconstructFromAdo(
  ctx: AppContext,
  ado: AdoClient,
  base: StackState,
): Promise<StackState | undefined> {
  const prs = await ado.listPullRequests({ status: "all" });
  const withMeta: Array<{
    pr: AdoPullRequest;
    parent: string;
    branch: string;
    stackId: string;
    lastRestackBase: string;
  }> = [];
  for (const pr of prs) {
    let properties: Record<string, string>;
    try {
      properties = await ado.getPullRequestProperties(pr.pullRequestId);
    } catch {
      continue;
    }
    const meta = decodeStackProperties(properties);
    if (!meta) {
      continue;
    }
    withMeta.push({
      pr,
      parent: meta.parent,
      branch: meta.branch || fromRefsHeads(pr.sourceRefName),
      stackId: meta.stackId,
      lastRestackBase: meta.lastRestackBase,
    });
  }
  if (withMeta.length === 0) {
    return undefined;
  }
  const stacks = new Map<string, typeof withMeta>();
  for (const item of withMeta) {
    const list = stacks.get(item.stackId) ?? [];
    list.push(item);
    stacks.set(item.stackId, list);
  }
  if (stacks.size > 1) {
    ctx.log.warn(
      `Found ${stacks.size} ado-stack IDs on pull requests. Not guessing which stack to adopt. Use the clone that created the stack, or pass branches explicitly after checking Azure DevOps.`,
    );
    return undefined;
  }
  const items = [...stacks.values()][0] ?? [];
  const branches: StackState["branches"] = {};
  for (const item of items) {
    if (item.pr.status === "abandoned") {
      continue;
    }
    if (
      item.pr.status === "completed" &&
      !items.some((other) => other.parent === item.branch && other.pr.status === "active")
    ) {
      continue;
    }
    const source = fromRefsHeads(item.pr.sourceRefName);
    let tip = item.pr.lastMergeSourceCommit?.commitId;
    if (!tip) {
      try {
        await ctx.git.fetch(base.remoteName);
        if (await ctx.git.remoteBranchExists(base.remoteName, source)) {
          tip = await ctx.git.getBranchTip(`${base.remoteName}/${source}`);
        }
      } catch {
        tip = undefined;
      }
    }
    branches[item.branch] = {
      parent: item.parent,
      parentTipAtCreation: item.lastRestackBase,
      lastRestackBase: item.lastRestackBase,
      lastLocalTip: tip ?? item.lastRestackBase,
      lastKnownRemoteTip: tip,
      lastSubmittedTip: tip,
      pullRequestId: item.pr.pullRequestId,
    };
  }
  const next: StackState = {
    ...base,
    stackId: items[0]?.stackId,
    branches,
  };
  try {
    stackOrder(next);
  } catch (error) {
    ctx.log.warn(
      `Remote metadata did not form a linear stack: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
  return next;
}

function stringFlag(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
