import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliError } from "../errors/cli-error.ts";

export type AuthKind = "pat" | "azure-cli" | "none";

export type ResolvedAuth =
  | { kind: "pat"; token: string; source: string }
  | { kind: "azure-cli"; token: string; source: string }
  | { kind: "none" };

export const ADO_ENTRA_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";

export function credentialsPath(configDir: string): string {
  return join(configDir, "credentials.json");
}

export async function readStoredPat(configDir: string): Promise<string | undefined> {
  const file = Bun.file(credentialsPath(configDir));
  if (!(await file.exists())) {
    return undefined;
  }
  const raw: unknown = await file.json();
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const pat = (raw as { pat?: unknown }).pat;
  return typeof pat === "string" && pat.length > 0 ? pat : undefined;
}

export async function writeStoredPat(configDir: string, pat: string): Promise<void> {
  await mkdir(configDir, { recursive: true });
  const path = credentialsPath(configDir);
  await Bun.write(path, `${JSON.stringify({ version: 1, pat }, null, 2)}\n`);
  await chmod(path, 0o600).catch(() => undefined);
}

export async function deleteStoredPat(configDir: string): Promise<void> {
  const file = Bun.file(credentialsPath(configDir));
  if (await file.exists()) {
    await file.delete();
  }
}

export async function azureCliAccessToken(
  run: (args: string[]) => Promise<{ stdout: string; exitCode: number; stderr: string }> = runAz,
): Promise<string> {
  const result = await run([
    "account",
    "get-access-token",
    "--resource",
    ADO_ENTRA_RESOURCE,
    "--query",
    "accessToken",
    "-o",
    "tsv",
  ]);
  if (result.exitCode !== 0) {
    throw new CliError(
      "Could not obtain an Azure DevOps token from Azure CLI.\n\nRun `az login` and confirm you can access the organization, or set AZURE_DEVOPS_EXT_PAT.",
      { cause: new Error(result.stderr.trim()) },
    );
  }
  const token = result.stdout.trim();
  if (!token) {
    throw new CliError("Azure CLI returned an empty access token.");
  }
  return token;
}

async function runAz(
  args: string[],
): Promise<{ stdout: string; exitCode: number; stderr: string }> {
  if (!Bun.which("az")) {
    return { stdout: "", stderr: "az not found", exitCode: 127 };
  }
  const proc = Bun.spawn(["az", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const timer = setTimeout(() => {
    proc.kill();
  }, 2500);
  try {
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timer);
  }
}

export function authHeader(auth: Exclude<ResolvedAuth, { kind: "none" }>): string {
  if (auth.kind === "pat") {
    return `Basic ${btoa(`:${auth.token}`)}`;
  }
  return `Bearer ${auth.token}`;
}

export async function resolveAuth(options: {
  configDir: string;
  authMode: "auto" | "pat" | "azure-cli";
  env?: NodeJS.Dict<string>;
  azureCli?: () => Promise<string>;
}): Promise<ResolvedAuth> {
  const env = options.env ?? process.env;
  const pat =
    firstNonEmpty(env.ADO_STACK_PAT, env.AZURE_DEVOPS_EXT_PAT, env.SYSTEM_ACCESSTOKEN) ??
    (await readStoredPat(options.configDir));
  const patSource = env.ADO_STACK_PAT
    ? "ADO_STACK_PAT"
    : env.AZURE_DEVOPS_EXT_PAT
      ? "AZURE_DEVOPS_EXT_PAT"
      : env.SYSTEM_ACCESSTOKEN
        ? "SYSTEM_ACCESSTOKEN"
        : "credentials file";

  if (options.authMode === "pat") {
    if (!pat) {
      return { kind: "none" };
    }
    return { kind: "pat", token: pat, source: patSource };
  }

  if (options.authMode === "azure-cli") {
    const token = await (options.azureCli ?? azureCliAccessToken)();
    return { kind: "azure-cli", token, source: "az account get-access-token" };
  }

  if (pat) {
    return { kind: "pat", token: pat, source: patSource };
  }
  try {
    const token = await (options.azureCli ?? azureCliAccessToken)();
    return { kind: "azure-cli", token, source: "az account get-access-token" };
  } catch {
    return { kind: "none" };
  }
}

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  return values.find((value) => value && value.length > 0);
}

export function missingAuthError(): CliError {
  return new CliError(
    "No Azure DevOps credentials were found.\n\nSet AZURE_DEVOPS_EXT_PAT, run `ado-stack auth login`, or `az login` and retry.",
  );
}

export function globalConfigDir(env: NodeJS.Dict<string> = process.env): string {
  if (env.ADO_STACK_CONFIG_DIR) {
    return env.ADO_STACK_CONFIG_DIR;
  }
  if (process.platform === "win32") {
    return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "ado-stack");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "ado-stack");
  }
  const xdg = env.XDG_CONFIG_HOME;
  return join(xdg && xdg.length > 0 ? xdg : join(homedir(), ".config"), "ado-stack");
}
