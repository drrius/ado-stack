#!/usr/bin/env bun

import { appendFile } from "node:fs/promises";
import { compareReleaseVersions, parseReleaseVersion } from "../src/update.ts";

const PACKAGE_VERSION = /^\d+\.\d+\.\d+$/;
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;

export type TagDecision =
  | { kind: "skip"; reason: "unchanged" | "tag-exists" | "not-greater"; detail: string }
  | { kind: "tag"; tag: string; version: string }
  | { kind: "fail"; reason: "invalid-version"; detail: string };

export function isStrictPackageVersion(version: string): boolean {
  return PACKAGE_VERSION.test(version);
}

export function decideTagRelease(input: {
  oldVersion: string | undefined;
  newVersion: string;
  existingTags: readonly string[];
}): TagDecision {
  const oldVersion = input.oldVersion?.trim() || undefined;
  const newVersion = input.newVersion.trim();
  const existingTags = input.existingTags.map((tag) => tag.trim()).filter((tag) => tag !== "");

  if (oldVersion !== undefined && oldVersion === newVersion) {
    return {
      kind: "skip",
      reason: "unchanged",
      detail: `package.json version is still ${newVersion}`,
    };
  }

  if (!isStrictPackageVersion(newVersion)) {
    return {
      kind: "fail",
      reason: "invalid-version",
      detail: `package.json version "${newVersion}" is not strict X.Y.Z`,
    };
  }

  const tag = `v${newVersion}`;
  if (existingTags.includes(tag)) {
    return { kind: "skip", reason: "tag-exists", detail: `${tag} already exists` };
  }

  const latest = latestReleaseVersion(existingTags);
  if (latest !== undefined && compareReleaseVersions(newVersion, latest) <= 0) {
    return {
      kind: "skip",
      reason: "not-greater",
      detail: `${tag} is not greater than latest tag v${latest}`,
    };
  }

  return { kind: "tag", tag, version: newVersion };
}

export function latestReleaseVersion(tags: readonly string[]): string | undefined {
  let latest: string | undefined;
  for (const tag of tags) {
    if (!RELEASE_TAG.test(tag.trim())) {
      continue;
    }
    const version = parseReleaseVersion(tag);
    if (version === undefined) {
      continue;
    }
    if (latest === undefined || compareReleaseVersions(version, latest) > 0) {
      latest = version;
    }
  }
  return latest;
}

export function formatDecision(decision: TagDecision): string {
  switch (decision.kind) {
    case "tag":
      return `tag ${decision.tag}`;
    case "skip":
      return `skip ${decision.reason}`;
    case "fail":
      return `fail ${decision.reason}`;
    default: {
      const exhaustive: never = decision;
      return exhaustive;
    }
  }
}

export async function readRepoTagInput(options: {
  cwd?: string;
  beforeSha?: string;
}): Promise<{ oldVersion: string | undefined; newVersion: string; existingTags: string[] }> {
  const cwd = options.cwd ?? process.cwd();
  const currentText = await gitShow("HEAD:package.json", cwd);
  if (currentText === undefined) {
    throw new Error("HEAD:package.json is missing");
  }
  const newVersion = versionFromPackageJson(currentText);
  const oldVersion = await previousPackageVersion(cwd, options.beforeSha);
  const existingTags = await listReleaseTags(cwd);
  return { oldVersion, newVersion, existingTags };
}

export function parseTagReleaseArgs(argv: string[]): {
  oldVersion: string | undefined;
  newVersion: string | undefined;
  existingTags: string[];
  help: boolean;
} {
  let oldVersion: string | undefined;
  let newVersion: string | undefined;
  let existingTags: string[] = [];
  let help = false;
  let sawOld = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--old") {
      sawOld = true;
      oldVersion = argv[++i];
      continue;
    }
    if (arg === "--new") {
      newVersion = argv[++i];
      continue;
    }
    if (arg === "--tags") {
      existingTags = (argv[++i] ?? "")
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag !== "");
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (sawOld && (oldVersion === undefined || oldVersion === "")) {
    oldVersion = undefined;
  }

  return { oldVersion, newVersion, existingTags, help };
}

function versionFromPackageJson(text: string): string {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || typeof parsed.version !== "string") {
    throw new Error("package.json version is missing");
  }
  return parsed.version;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isZeroSha(sha: string): boolean {
  return /^0+$/.test(sha);
}

async function previousPackageVersion(
  cwd: string,
  beforeSha: string | undefined,
): Promise<string | undefined> {
  const refs: string[] = [];
  if (beforeSha !== undefined && beforeSha !== "" && !isZeroSha(beforeSha)) {
    refs.push(`${beforeSha}:package.json`);
  }
  refs.push("HEAD^:package.json");
  for (const spec of refs) {
    const text = await gitShow(spec, cwd);
    if (text === undefined) {
      continue;
    }
    return versionFromPackageJson(text);
  }
  return undefined;
}

async function listReleaseTags(cwd: string): Promise<string[]> {
  const result = await git(["tag", "-l", "v*"], cwd);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || "git tag -l v* failed");
  }
  return result.stdout
    .split(/\r?\n/)
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "");
}

async function gitShow(spec: string, cwd: string): Promise<string | undefined> {
  const result = await git(["show", spec], cwd);
  if (result.exitCode !== 0) {
    return undefined;
  }
  return result.stdout;
}

async function git(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

async function writeGithubOutput(decision: TagDecision): Promise<void> {
  const file = process.env.GITHUB_OUTPUT;
  if (file === undefined || file === "") {
    return;
  }
  const tag = decision.kind === "tag" ? decision.tag : "";
  await appendFile(file, `tag=${tag}\nreason=${formatDecision(decision)}\n`);
}

function printHelp(): void {
  console.log(`Usage:
  bun run scripts/tag-release.ts --old <version> --new <version> [--tags v0.1.0,v0.2.0]
  bun run scripts/tag-release.ts

Fixture mode decides from the flags. Git mode reads HEAD / previous package.json
and existing v* tags. Prints "tag vX.Y.Z", "skip <reason>", or "fail <reason>".
`);
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseTagReleaseArgs(argv);
  if (parsed.help) {
    printHelp();
    return 0;
  }

  const input =
    parsed.newVersion === undefined
      ? await readRepoTagInput({
          cwd: process.cwd(),
          beforeSha: process.env.GITHUB_EVENT_BEFORE,
        })
      : {
          oldVersion: parsed.oldVersion,
          newVersion: parsed.newVersion,
          existingTags: parsed.existingTags,
        };

  const decision = decideTagRelease(input);
  console.log(formatDecision(decision));
  if (decision.kind !== "tag") {
    console.log(decision.detail);
  }
  await writeGithubOutput(decision);
  return decision.kind === "fail" ? 1 : 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
