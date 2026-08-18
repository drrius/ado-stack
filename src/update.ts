import { chmod, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { CliError } from "./errors/cli-error.ts";
import { GITHUB_REPOSITORY, VERSION } from "./version.ts";

export type UpdateNotice =
  | { kind: "current"; current: string }
  | { kind: "available"; current: string; latest: string }
  | { kind: "unknown" };

export type InstallKind = "binary" | "source";

export type ReleaseTarget = {
  asset: string;
  binaryName: string;
};

export type HttpFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const DEFAULT_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CHECK_TIMEOUT_MS = 1_500;
const DEFAULT_APPLY_TIMEOUT_MS = 30_000;
const CACHE_FILE = "update-check.json";

export const INSTALL_SCRIPT_UNIX =
  "curl -fsSL https://raw.githubusercontent.com/drrius/ado-stack/main/install.sh | sh";
export const INSTALL_SCRIPT_WINDOWS =
  "irm https://raw.githubusercontent.com/drrius/ado-stack/main/install.ps1 | iex";

export function parseReleaseVersion(tag: string): string | undefined {
  const match = tag.trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : undefined;
}

export function compareReleaseVersions(left: string, right: string): number {
  const a = parts(left);
  const b = parts(right);
  if (a === undefined || b === undefined) {
    return 0;
  }
  for (let i = 0; i < 3; i++) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta !== 0) {
      return delta < 0 ? -1 : 1;
    }
  }
  return 0;
}

export function noticeFromVersions(current: string, latest: string): UpdateNotice {
  return compareReleaseVersions(latest, current) > 0
    ? { kind: "available", current, latest }
    : { kind: "current", current };
}

export function installKind(execPath: string = process.execPath): InstallKind {
  const name = basename(execPath).toLowerCase();
  return name === "bun" || name === "bun.exe" || name === "node" || name === "node.exe"
    ? "source"
    : "binary";
}

export function releaseTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ReleaseTarget | undefined {
  if (platform === "linux" && (arch === "x64" || arch === "x86_64")) {
    return { asset: "ado-stack-linux-x64", binaryName: "ado-stack" };
  }
  if (platform === "darwin" && (arch === "arm64" || arch === "aarch64")) {
    return { asset: "ado-stack-darwin-arm64", binaryName: "ado-stack" };
  }
  if (platform === "darwin" && (arch === "x64" || arch === "x86_64")) {
    return { asset: "ado-stack-darwin-x64", binaryName: "ado-stack" };
  }
  if (platform === "win32" && (arch === "x64" || arch === "x86_64")) {
    return { asset: "ado-stack-windows-x64.exe", binaryName: "ado-stack.exe" };
  }
  return undefined;
}

export function installHint(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? INSTALL_SCRIPT_WINDOWS : INSTALL_SCRIPT_UNIX;
}

export function formatUpdateNote(notice: UpdateNotice): string | undefined {
  if (notice.kind !== "available") {
    return undefined;
  }
  return `${notice.latest} is available. This install is ${notice.current}.`;
}

export function updateCheckDisabled(env: NodeJS.Dict<string> = process.env): boolean {
  const value = env.ADO_STACK_NO_UPDATE_CHECK;
  return value !== undefined && value !== "" && value !== "0";
}

export async function checkForUpdate(options: {
  current: string;
  configDir: string;
  fetch?: HttpFetch;
  now?: Date;
  ttlMs?: number;
  timeoutMs?: number;
  force?: boolean;
  repository?: string;
  disabled?: boolean;
}): Promise<UpdateNotice> {
  if ((options.disabled ?? updateCheckDisabled()) && !options.force) {
    return { kind: "unknown" };
  }
  const now = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? DEFAULT_CHECK_TTL_MS;
  const cached = await readCache(options.configDir);
  if (cached && !options.force) {
    const notice = noticeFromVersions(options.current, cached.latest);
    const ageMs = now.getTime() - Date.parse(cached.checkedAt);
    const fresh = Number.isFinite(ageMs) && ageMs >= 0 && ageMs < ttlMs;
    if (fresh) {
      return notice;
    }
  }
  try {
    const latest = await fetchLatestVersion({
      fetch: options.fetch ?? fetch,
      timeoutMs: options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS,
      repository: resolveRepository(options.repository),
    });
    await writeCache(options.configDir, { version: 1, checkedAt: now.toISOString(), latest });
    return noticeFromVersions(options.current, latest);
  } catch {
    return cached ? noticeFromVersions(options.current, cached.latest) : { kind: "unknown" };
  }
}

export async function applyUpdate(options: {
  destPath: string;
  version: string;
  fetch?: HttpFetch;
  timeoutMs?: number;
  repository?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  moveFile?: (from: string, to: string) => Promise<void>;
}): Promise<{ latest: string; destPath: string }> {
  const latest = parseReleaseVersion(options.version);
  if (latest === undefined) {
    throw new CliError(`Invalid release version \`${options.version}\`.`);
  }
  const target = releaseTarget(options.platform, options.arch);
  if (target === undefined) {
    throw new CliError(
      `No release binary for ${options.platform ?? process.platform}/${options.arch ?? process.arch}.`,
      { hint: `Install manually:\n  ${installHint(options.platform)}` },
    );
  }
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_APPLY_TIMEOUT_MS;
  const repository = resolveRepository(options.repository);
  const tag = `v${latest}`;
  const [bytes, sums] = await Promise.all([
    fetchBytes(assetUrl(repository, tag, target.asset), fetchImpl, timeoutMs),
    fetchText(assetUrl(repository, tag, "SHA256SUMS"), fetchImpl, timeoutMs),
  ]);
  const expected = checksumForAsset(sums, target.asset);
  if (expected === undefined) {
    throw new CliError(`No SHA256 entry for ${target.asset} in SHA256SUMS.`);
  }
  const actual = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw new CliError(`Checksum mismatch for ${target.asset}.`);
  }
  const staged = `${options.destPath}.new`;
  await Bun.write(staged, bytes);
  await chmod(staged, 0o755);
  await replaceInstalledBinary({
    destPath: options.destPath,
    staged,
    platform: options.platform ?? process.platform,
    moveFile: options.moveFile ?? rename,
  });
  return { latest, destPath: options.destPath };
}

async function replaceInstalledBinary(options: {
  destPath: string;
  staged: string;
  platform: NodeJS.Platform;
  moveFile: (from: string, to: string) => Promise<void>;
}): Promise<void> {
  const previous = `${options.destPath}.old`;
  let movedAside = false;
  try {
    if (options.platform === "win32" && (await Bun.file(options.destPath).exists())) {
      await rm(previous, { force: true });
      await options.moveFile(options.destPath, previous);
      movedAside = true;
    }
    await options.moveFile(options.staged, options.destPath);
  } catch (error) {
    if (movedAside) {
      await options.moveFile(previous, options.destPath).catch(() => undefined);
    }
    throw new CliError("Could not replace the installed ado-stack binary.", {
      hint: `Install manually:\n  ${installHint(options.platform)}`,
      cause: error,
    });
  }
}

function parts(version: string): [number, number, number] | undefined {
  const parsed = parseReleaseVersion(version);
  if (parsed === undefined) {
    return undefined;
  }
  const [major, minor, patch] = parsed.split(".").map((value) => Number(value));
  if (major === undefined || minor === undefined || patch === undefined) {
    return undefined;
  }
  return [major, minor, patch];
}

function resolveRepository(explicit?: string): string {
  return explicit ?? process.env.ADO_STACK_GITHUB_REPO ?? GITHUB_REPOSITORY;
}

function assetUrl(repository: string, tag: string, name: string): string {
  return `https://github.com/${repository}/releases/download/${tag}/${name}`;
}

async function fetchLatestVersion(options: {
  fetch: HttpFetch;
  timeoutMs: number;
  repository: string;
}): Promise<string> {
  const url = `https://api.github.com/repos/${options.repository}/releases/latest`;
  const body = await fetchJson(url, options.fetch, options.timeoutMs);
  const tag = isRecord(body) && typeof body.tag_name === "string" ? body.tag_name : undefined;
  const latest = tag === undefined ? undefined : parseReleaseVersion(tag);
  if (latest === undefined) {
    throw new Error("latest release has no version tag");
  }
  return latest;
}

async function fetchJson(url: string, fetchImpl: HttpFetch, timeoutMs: number): Promise<unknown> {
  const response = await request(url, fetchImpl, timeoutMs, "application/vnd.github+json");
  return response.json();
}

async function fetchText(url: string, fetchImpl: HttpFetch, timeoutMs: number): Promise<string> {
  const response = await request(url, fetchImpl, timeoutMs, "text/plain");
  return response.text();
}

async function fetchBytes(
  url: string,
  fetchImpl: HttpFetch,
  timeoutMs: number,
): Promise<Uint8Array> {
  const response = await request(url, fetchImpl, timeoutMs, "application/octet-stream");
  return new Uint8Array(await response.arrayBuffer());
}

async function request(
  url: string,
  fetchImpl: HttpFetch,
  timeoutMs: number,
  accept: string,
): Promise<Response> {
  const response = await fetchImpl(url, {
    headers: {
      Accept: accept,
      "User-Agent": `ado-stack/${VERSION}`,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${url}`);
  }
  return response;
}

function checksumForAsset(sums: string, asset: string): string | undefined {
  for (const line of sums.split(/\r?\n/)) {
    const match = line.match(/^([a-fA-F0-9]{64})\s+(\S+)$/);
    const hash = match?.[1];
    if (hash !== undefined && match?.[2] === asset) {
      return hash.toLowerCase();
    }
  }
  return undefined;
}

type UpdateCheckCache = {
  version: 1;
  checkedAt: string;
  latest: string;
};

async function readCache(configDir: string): Promise<UpdateCheckCache | undefined> {
  const file = Bun.file(join(configDir, CACHE_FILE));
  if (!(await file.exists())) {
    return undefined;
  }
  try {
    return parseCache(await file.json());
  } catch {
    return undefined;
  }
}

async function writeCache(configDir: string, cache: UpdateCheckCache): Promise<void> {
  await Bun.write(join(configDir, CACHE_FILE), `${JSON.stringify(cache, null, 2)}\n`);
}

function parseCache(value: unknown): UpdateCheckCache | undefined {
  if (!isRecord(value) || value.version !== 1) {
    return undefined;
  }
  if (typeof value.checkedAt !== "string" || typeof value.latest !== "string") {
    return undefined;
  }
  if (parseReleaseVersion(value.latest) === undefined) {
    return undefined;
  }
  return { version: 1, checkedAt: value.checkedAt, latest: value.latest };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
