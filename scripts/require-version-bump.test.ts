import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideVersionBump,
  formatDecision,
  parseRequireVersionBumpArgs,
  readRepoVersionBumpInput,
} from "./require-version-bump.ts";

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("decideVersionBump", () => {
  test("accepts a patch bump", () => {
    expect(decideVersionBump({ baseVersion: "0.2.1", newVersion: "0.2.2" })).toEqual({
      kind: "ok",
      baseVersion: "0.2.1",
      newVersion: "0.2.2",
    });
  });

  test("accepts a minor bump", () => {
    expect(decideVersionBump({ baseVersion: "0.2.1", newVersion: "0.3.0" })).toEqual({
      kind: "ok",
      baseVersion: "0.2.1",
      newVersion: "0.3.0",
    });
  });

  test("fails when the version did not change", () => {
    expect(decideVersionBump({ baseVersion: "0.2.1", newVersion: "0.2.1" })).toEqual({
      kind: "fail",
      reason: "unchanged",
      detail: "package.json version is still 0.2.1",
    });
  });

  test("fails when the new version is lower", () => {
    expect(decideVersionBump({ baseVersion: "0.2.1", newVersion: "0.2.0" })).toEqual({
      kind: "fail",
      reason: "not-greater",
      detail: "0.2.0 is not greater than 0.2.1",
    });
  });

  test("refuses pre-release and other non X.Y.Z new versions", () => {
    expect(decideVersionBump({ baseVersion: "0.2.1", newVersion: "0.2.2-beta" })).toMatchObject({
      kind: "fail",
      reason: "invalid-new",
    });
    expect(decideVersionBump({ baseVersion: "0.2.1", newVersion: "v0.2.2" })).toMatchObject({
      kind: "fail",
      reason: "invalid-new",
    });
  });

  test("refuses a non X.Y.Z base version", () => {
    expect(decideVersionBump({ baseVersion: "0.2.1-beta", newVersion: "0.2.2" })).toMatchObject({
      kind: "fail",
      reason: "invalid-base",
    });
  });

  test("fails when the base version is missing", () => {
    expect(decideVersionBump({ newVersion: "0.2.2" })).toMatchObject({
      kind: "fail",
      reason: "missing-base",
    });
    expect(decideVersionBump({ baseVersion: "", newVersion: "0.2.2" })).toMatchObject({
      kind: "fail",
      reason: "missing-base",
    });
  });

  test("fails when the head version is missing", () => {
    expect(decideVersionBump({ baseVersion: "0.2.1" })).toMatchObject({
      kind: "fail",
      reason: "missing-head",
    });
    expect(decideVersionBump({})).toMatchObject({
      kind: "fail",
      reason: "missing-head",
    });
  });
});

describe("require-version-bump CLI", () => {
  test("fixture flags print a reviewer-runnable decision", async () => {
    const bumped = await runRequireVersionBump(["--old", "0.2.1", "--new", "0.2.2"]);
    expect(bumped.exitCode).toBe(0);
    expect(bumped.stdout).toContain("ok 0.2.1 -> 0.2.2");

    const unchanged = await runRequireVersionBump(["--old", "0.2.1", "--new", "0.2.1"]);
    expect(unchanged.exitCode).toBe(1);
    expect(unchanged.stdout).toContain("fail unchanged");
    expect(unchanged.stdout).toContain("package.json version is still 0.2.1");

    const lower = await runRequireVersionBump(["--old", "0.2.1", "--new", "0.2.0"]);
    expect(lower.exitCode).toBe(1);
    expect(lower.stdout).toContain("fail not-greater");

    const invalid = await runRequireVersionBump(["--old", "0.2.1", "--new", "0.2.2-beta"]);
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stdout).toContain("fail invalid-new");
  });

  test("parseRequireVersionBumpArgs treats empty --old as missing", () => {
    expect(parseRequireVersionBumpArgs(["--old", "", "--new", "0.2.2"])).toEqual({
      baseVersion: undefined,
      newVersion: "0.2.2",
      base: undefined,
      help: false,
    });
  });

  test("parseRequireVersionBumpArgs rejects unknown flags", () => {
    expect(() => parseRequireVersionBumpArgs(["--wat"])).toThrow("Unknown argument: --wat");
  });

  test("help exits 0", async () => {
    const help = await runRequireVersionBump(["--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("Usage:");
  });

  test("git mode compares base package.json to the working tree", async () => {
    const dir = await tempRepo();
    await git(dir, ["init", "--initial-branch=main"]);
    await git(dir, ["config", "user.email", "ado-stack-test@example.com"]);
    await git(dir, ["config", "user.name", "ado-stack test"]);
    await git(dir, ["config", "commit.gpgsign", "false"]);
    await writeFile(join(dir, "package.json"), `${JSON.stringify({ version: "0.2.1" })}\n`);
    await git(dir, ["add", "package.json"]);
    await git(dir, ["commit", "-m", "0.2.1"]);
    await writeFile(join(dir, "package.json"), `${JSON.stringify({ version: "0.2.2" })}\n`);

    const input = await readRepoVersionBumpInput({ cwd: dir, base: "HEAD" });
    expect(input).toEqual({
      baseVersion: "0.2.1",
      newVersion: "0.2.2",
    });
    expect(formatDecision(decideVersionBump(input))).toBe("ok 0.2.1 -> 0.2.2");

    const bumped = await runRequireVersionBump(["--base", "HEAD"], { cwd: dir });
    expect(bumped.exitCode).toBe(0);
    expect(bumped.stdout).toContain("ok 0.2.1 -> 0.2.2");
  });

  test("git mode fails when the base spec or working-tree package.json is missing", async () => {
    const dir = await tempRepo();
    await git(dir, ["init", "--initial-branch=main"]);
    await git(dir, ["config", "user.email", "ado-stack-test@example.com"]);
    await git(dir, ["config", "user.name", "ado-stack test"]);
    await git(dir, ["config", "commit.gpgsign", "false"]);
    await writeFile(join(dir, "package.json"), `${JSON.stringify({ version: "0.2.2" })}\n`);
    await git(dir, ["add", "package.json"]);
    await git(dir, ["commit", "-m", "0.2.2"]);

    const missingBase = await runRequireVersionBump(["--base", "origin/does-not-exist"], {
      cwd: dir,
    });
    expect(missingBase.exitCode).toBe(1);
    expect(missingBase.stdout).toContain("fail missing-base");

    await rm(join(dir, "package.json"));
    const missingHead = await runRequireVersionBump(["--base", "HEAD"], { cwd: dir });
    expect(missingHead.exitCode).toBe(1);
    expect(missingHead.stdout).toContain("fail missing-head");
  });
});

async function runRequireVersionBump(
  args: string[],
  options: { cwd?: string } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(
    ["bun", "run", join(import.meta.dir, "require-version-bump.ts"), ...args],
    {
      cwd: options.cwd ?? import.meta.dir,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

async function tempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ado-stack-require-version-bump-"));
  temps.push(dir);
  return dir;
}

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `git ${args.join(" ")} failed`);
  }
}
