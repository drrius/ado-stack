#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { compareReleaseVersions } from "../src/update.ts";
import { isStrictPackageVersion } from "./tag-release.ts";

export type VersionBumpDecision =
  | { kind: "ok"; baseVersion: string; newVersion: string }
  | {
      kind: "fail";
      reason:
        | "unchanged"
        | "not-greater"
        | "invalid-new"
        | "invalid-base"
        | "missing-base"
        | "missing-head";
      detail: string;
    };

export function decideVersionBump(input: {
  baseVersion?: string;
  newVersion?: string;
}): VersionBumpDecision {
  const baseVersion = input.baseVersion?.trim() || undefined;
  const newVersion = input.newVersion?.trim() || undefined;

  if (newVersion === undefined) {
    return {
      kind: "fail",
      reason: "missing-head",
      detail: "package.json version is missing",
    };
  }

  if (baseVersion === undefined) {
    return {
      kind: "fail",
      reason: "missing-base",
      detail: "base package.json version is missing",
    };
  }

  if (!isStrictPackageVersion(newVersion)) {
    return {
      kind: "fail",
      reason: "invalid-new",
      detail: `package.json version "${newVersion}" is not strict X.Y.Z`,
    };
  }

  if (!isStrictPackageVersion(baseVersion)) {
    return {
      kind: "fail",
      reason: "invalid-base",
      detail: `base package.json version "${baseVersion}" is not strict X.Y.Z`,
    };
  }

  if (baseVersion === newVersion) {
    return {
      kind: "fail",
      reason: "unchanged",
      detail: `package.json version is still ${newVersion}`,
    };
  }

  if (compareReleaseVersions(newVersion, baseVersion) <= 0) {
    return {
      kind: "fail",
      reason: "not-greater",
      detail: `${newVersion} is not greater than ${baseVersion}`,
    };
  }

  return { kind: "ok", baseVersion, newVersion };
}

export function formatDecision(decision: VersionBumpDecision): string {
  switch (decision.kind) {
    case "ok":
      return `ok ${decision.baseVersion} -> ${decision.newVersion}`;
    case "fail":
      return `fail ${decision.reason}`;
    default: {
      const exhaustive: never = decision;
      return exhaustive;
    }
  }
}

export async function readRepoVersionBumpInput(options: {
  cwd?: string;
  base: string;
}): Promise<{ baseVersion: string | undefined; newVersion: string | undefined }> {
  const cwd = options.cwd ?? process.cwd();
  const baseText = await gitShow(`${options.base}:package.json`, cwd);
  const baseVersion = baseText === undefined ? undefined : versionFromPackageJson(baseText);
  const newVersion = await workingTreeVersion(cwd);
  return { baseVersion, newVersion };
}

export function parseRequireVersionBumpArgs(argv: string[]): {
  baseVersion: string | undefined;
  newVersion: string | undefined;
  base: string | undefined;
  help: boolean;
} {
  let baseVersion: string | undefined;
  let newVersion: string | undefined;
  let base: string | undefined;
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
      baseVersion = argv[++i];
      continue;
    }
    if (arg === "--new") {
      newVersion = argv[++i];
      continue;
    }
    if (arg === "--base") {
      base = argv[++i];
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (sawOld && (baseVersion === undefined || baseVersion === "")) {
    baseVersion = undefined;
  }

  return { baseVersion, newVersion, base, help };
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

async function workingTreeVersion(cwd: string): Promise<string | undefined> {
  try {
    const text = await readFile(join(cwd, "package.json"), "utf8");
    return versionFromPackageJson(text);
  } catch (error) {
    if (isEnoent(error)) {
      return undefined;
    }
    throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
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

function printHelp(): void {
  console.log(`Usage:
  bun run scripts/require-version-bump.ts --old <version> --new <version>
  bun run scripts/require-version-bump.ts --base <git-spec>

Fixture mode decides from the flags. Git mode reads <git-spec>:package.json
and the working-tree package.json. Prints "ok <base> -> <new>" or "fail <reason>".
`);
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseRequireVersionBumpArgs(argv);
  if (parsed.help) {
    printHelp();
    return 0;
  }

  const input =
    parsed.base === undefined
      ? { baseVersion: parsed.baseVersion, newVersion: parsed.newVersion }
      : await readRepoVersionBumpInput({
          cwd: process.cwd(),
          base: parsed.base,
        });

  const decision = decideVersionBump(input);
  console.log(formatDecision(decision));
  if (decision.kind === "fail") {
    console.log(decision.detail);
  }
  return decision.kind === "ok" ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
