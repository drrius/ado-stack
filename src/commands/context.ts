import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { AdoClient } from "../ado/client.ts";
import { parseAzureDevOpsRemote } from "../ado/remote.ts";
import { authHeader, globalConfigDir, missingAuthError, resolveAuth } from "../auth/credentials.ts";
import { type ResolvedConfig, resolveConfig } from "../config/schema.ts";
import { ConfigStore } from "../config/store.ts";
import { CliError } from "../errors/cli-error.ts";
import { GitRepo } from "../git/git.ts";
import type { StackState } from "../state/schema.ts";
import { StateStore } from "../state/store.ts";
import type { Logger } from "../ui/log.ts";

export type AppContext = {
  cwd: string;
  git: GitRepo;
  gitDir: string;
  log: Logger;
  verbose: boolean;
  debug: boolean;
  config: ResolvedConfig;
  configStore: ConfigStore;
  stateStore: StateStore;
  configDir: string;
};

export type AdoAccess =
  | { status: "ready"; client: AdoClient }
  | { status: "unavailable"; reason: "unauthenticated" | "error"; message: string };

export async function loadContext(options: {
  cwd: string;
  log: Logger;
  verbose: boolean;
  debug: boolean;
  requireGit?: boolean;
}): Promise<AppContext> {
  const git = new GitRepo(options.cwd);
  const isRepo = await git.isRepository();
  if (!isRepo && options.requireGit !== false) {
    throw new CliError("This directory is not a Git repository.");
  }
  const gitDir = isRepo ? await git.gitDir() : join(options.cwd, ".git");
  const configDir = globalConfigDir();
  const configStore = new ConfigStore(configDir, isRepo ? gitDir : undefined);
  const [globalConfig, repoConfig] = await Promise.all([
    configStore.readGlobal(),
    configStore.readRepo(),
  ]);
  const config = resolveConfig({ global: globalConfig, repo: repoConfig });
  if (!isRepo) {
    await mkdir(configDir, { recursive: true });
  }
  return {
    cwd: options.cwd,
    git,
    gitDir,
    log: options.log,
    verbose: options.verbose,
    debug: options.debug,
    config,
    configStore,
    stateStore: new StateStore(gitDir),
    configDir,
  };
}

export async function requireState(ctx: AppContext): Promise<StackState> {
  const state = await ctx.stateStore.read();
  if (!state) {
    throw new CliError("No ado-stack state in this repository. Run `ado-stack init` first.");
  }
  return state;
}

export async function detectRemote(ctx: AppContext): Promise<
  | {
      remoteName: string;
      url: string;
    }
  | undefined
> {
  const preferred = ctx.config.remoteName;
  const remotes = await ctx.git.listRemotes();
  const order = [preferred, ...remotes.filter((name) => name !== preferred)];
  for (const name of order) {
    const url = await ctx.git.getRemoteUrl(name);
    if (!url) {
      continue;
    }
    if (parseAzureDevOpsRemote(url)) {
      return { remoteName: name, url };
    }
  }
  const origin = await ctx.git.getRemoteUrl("origin");
  if (origin) {
    return { remoteName: "origin", url: origin };
  }
  return undefined;
}

export async function createAdoClient(ctx: AppContext, state: StackState): Promise<AdoClient> {
  const auth = await resolveAuth({
    configDir: ctx.configDir,
    authMode: ctx.config.authMode,
  });
  if (auth.kind === "none") {
    throw missingAuthError();
  }
  return adoClient(ctx, state, authHeader(auth));
}

export async function resolveAdoAccess(ctx: AppContext, state: StackState): Promise<AdoAccess> {
  try {
    const auth = await resolveAuth({
      configDir: ctx.configDir,
      authMode: ctx.config.authMode,
    });
    if (auth.kind === "none") {
      return {
        status: "unavailable",
        reason: "unauthenticated",
        message: "Not authenticated to Azure DevOps.",
      };
    }
    return { status: "ready", client: adoClient(ctx, state, authHeader(auth)) };
  } catch (error) {
    return {
      status: "unavailable",
      reason: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function adoClient(ctx: AppContext, state: StackState, authorization: string): AdoClient {
  return new AdoClient({
    organizationUrl: state.organization,
    project: state.project,
    repositoryId: state.repositoryId ?? state.repository,
    authorization,
    logger: ctx.log,
  });
}

export function refsHeads(branch: string): string {
  return branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
}

export function fromRefsHeads(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}
