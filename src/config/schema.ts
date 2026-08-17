export type AuthMode = "auto" | "pat" | "azure-cli";

export type AppConfig = {
  version: 1;
  organization?: string;
  project?: string;
  repository?: string;
  defaultBranch?: string;
  branchPrefix?: string;
  authMode?: AuthMode;
};

export const CONFIG_KEYS = [
  "organization",
  "project",
  "repository",
  "defaultBranch",
  "branchPrefix",
  "authMode",
] as const;

export type ConfigKey = (typeof CONFIG_KEYS)[number];

export type ResolvedConfig = {
  organization?: string;
  project?: string;
  repository?: string;
  defaultBranch?: string;
  branchPrefix: string;
  authMode: AuthMode;
  remoteName: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseConfig(value: unknown): AppConfig {
  if (!isRecord(value)) {
    return { version: 1 };
  }
  const config: AppConfig = { version: 1 };
  for (const key of CONFIG_KEYS) {
    const raw = value[key];
    if (typeof raw === "string") {
      if (key === "authMode") {
        if (raw === "auto" || raw === "pat" || raw === "azure-cli") {
          config.authMode = raw;
        }
      } else {
        config[key] = raw;
      }
    }
  }
  return config;
}

export function mergeConfig(base: AppConfig, overlay: AppConfig): AppConfig {
  return {
    version: 1,
    organization: overlay.organization ?? base.organization,
    project: overlay.project ?? base.project,
    repository: overlay.repository ?? base.repository,
    defaultBranch: overlay.defaultBranch ?? base.defaultBranch,
    branchPrefix: overlay.branchPrefix ?? base.branchPrefix,
    authMode: overlay.authMode ?? base.authMode,
  };
}

export function resolveConfig(options: {
  global: AppConfig;
  repo: AppConfig;
  env?: NodeJS.Dict<string>;
}): ResolvedConfig {
  const env = options.env ?? process.env;
  const merged = mergeConfig(options.global, options.repo);
  return {
    organization: first(env.ADO_STACK_ORG, env.ADO_STACK_ORGANIZATION, merged.organization),
    project: first(env.ADO_STACK_PROJECT, merged.project),
    repository: first(env.ADO_STACK_REPO, env.ADO_STACK_REPOSITORY, merged.repository),
    defaultBranch: first(env.ADO_STACK_DEFAULT_BRANCH, merged.defaultBranch),
    branchPrefix: first(env.ADO_STACK_BRANCH_PREFIX, merged.branchPrefix) ?? "",
    authMode: parseAuthMode(env.ADO_STACK_AUTH_MODE) ?? merged.authMode ?? "auto",
    remoteName: first(env.ADO_STACK_REMOTE) ?? "origin",
  };
}

function parseAuthMode(value: string | undefined): AuthMode | undefined {
  if (value === "auto" || value === "pat" || value === "azure-cli") {
    return value;
  }
  return undefined;
}

function first(...values: (string | undefined)[]): string | undefined {
  return values.find((value) => value !== undefined && value.length > 0);
}

export function isConfigKey(value: string): value is ConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(value);
}
