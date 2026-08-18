import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideTagRelease,
  formatDecision,
  latestReleaseVersion,
  parseTagReleaseArgs,
  readRepoTagInput,
} from "./tag-release.ts";

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("decideTagRelease", () => {
  test("tags when package.json moves past the latest v* tag", () => {
    expect(
      decideTagRelease({
        oldVersion: "0.2.1",
        newVersion: "0.2.2",
        existingTags: ["v0.1.0", "v0.2.0", "v0.2.1"],
      }),
    ).toEqual({ kind: "tag", tag: "v0.2.2", version: "0.2.2" });
  });

  test("skips when the version did not change", () => {
    expect(
      decideTagRelease({
        oldVersion: "0.2.1",
        newVersion: "0.2.1",
        existingTags: ["v0.2.1"],
      }),
    ).toEqual({
      kind: "skip",
      reason: "unchanged",
      detail: "package.json version is still 0.2.1",
    });
  });

  test("ensures an existing tag still emits for release dispatch retry", () => {
    expect(
      decideTagRelease({
        oldVersion: "0.2.1",
        newVersion: "0.2.2",
        existingTags: ["v0.2.1", "v0.2.2"],
      }),
    ).toEqual({
      kind: "ensure",
      tag: "v0.2.2",
      version: "0.2.2",
      detail: "v0.2.2 already exists; release dispatch can be retried",
    });
  });

  test("skips equal or lower versions (reverts and bad edits)", () => {
    expect(
      decideTagRelease({
        oldVersion: "0.2.2",
        newVersion: "0.2.1",
        existingTags: ["v0.2.1", "v0.2.2"],
      }).kind,
    ).toBe("skip");
    expect(
      decideTagRelease({
        oldVersion: "0.2.1",
        newVersion: "0.2.0",
        existingTags: ["v0.2.1"],
      }),
    ).toMatchObject({ kind: "skip", reason: "not-greater" });
    expect(
      decideTagRelease({
        oldVersion: undefined,
        newVersion: "0.2.1",
        existingTags: ["v0.2.1"],
      }),
    ).toMatchObject({ kind: "ensure", tag: "v0.2.1" });
  });

  test("refuses pre-release and other non X.Y.Z versions", () => {
    expect(
      decideTagRelease({
        oldVersion: "0.2.1",
        newVersion: "0.2.2-beta",
        existingTags: ["v0.2.1"],
      }),
    ).toMatchObject({ kind: "fail", reason: "invalid-version" });
    expect(
      decideTagRelease({
        oldVersion: "0.2.1",
        newVersion: "v0.2.2",
        existingTags: ["v0.2.1"],
      }),
    ).toMatchObject({ kind: "fail", reason: "invalid-version" });
  });

  test("tags the first release when no v* tags exist", () => {
    expect(
      decideTagRelease({
        oldVersion: undefined,
        newVersion: "0.1.0",
        existingTags: [],
      }),
    ).toEqual({ kind: "tag", tag: "v0.1.0", version: "0.1.0" });
  });

  test("ignores pre-release tags when finding the latest", () => {
    expect(latestReleaseVersion(["v0.2.1", "v0.3.0-rc.1", "not-a-tag"])).toBe("0.2.1");
    expect(
      decideTagRelease({
        oldVersion: "0.2.1",
        newVersion: "0.2.2",
        existingTags: ["v0.2.1", "v0.2.2-rc.1"],
      }),
    ).toEqual({ kind: "tag", tag: "v0.2.2", version: "0.2.2" });
  });
});

describe("tag-release CLI", () => {
  test("fixture flags print a reviewer-runnable decision", async () => {
    const tagged = await runTagRelease([
      "--old",
      "0.2.1",
      "--new",
      "0.2.2",
      "--tags",
      "v0.1.0,v0.2.0,v0.2.1",
    ]);
    expect(tagged.exitCode).toBe(0);
    expect(tagged.stdout).toContain("tag v0.2.2");

    const unchanged = await runTagRelease(["--old", "0.2.1", "--new", "0.2.1", "--tags", "v0.2.1"]);
    expect(unchanged.exitCode).toBe(0);
    expect(unchanged.stdout).toContain("skip unchanged");

    const invalid = await runTagRelease(["--old", "0.2.1", "--new", "0.2.2-rc.1"]);
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stdout).toContain("fail invalid-version");
  });

  test("parseTagReleaseArgs treats empty --old as missing", () => {
    expect(parseTagReleaseArgs(["--old", "", "--new", "0.2.2"])).toEqual({
      oldVersion: undefined,
      newVersion: "0.2.2",
      existingTags: [],
      help: false,
    });
  });

  test("git mode compares HEAD^ package.json to HEAD and lists tags", async () => {
    const dir = await tempRepo();
    await git(dir, ["init", "--initial-branch=main"]);
    await git(dir, ["config", "user.email", "ado-stack-test@example.com"]);
    await git(dir, ["config", "user.name", "ado-stack test"]);
    await git(dir, ["config", "commit.gpgsign", "false"]);
    await writeFile(join(dir, "package.json"), `${JSON.stringify({ version: "0.2.1" })}\n`);
    await git(dir, ["add", "package.json"]);
    await git(dir, ["commit", "-m", "0.2.1"]);
    await git(dir, ["tag", "v0.2.1"]);
    await writeFile(join(dir, "package.json"), `${JSON.stringify({ version: "0.2.2" })}\n`);
    await git(dir, ["add", "package.json"]);
    await git(dir, ["commit", "-m", "0.2.2"]);

    const input = await readRepoTagInput({ cwd: dir });
    expect(input).toEqual({
      oldVersion: "0.2.1",
      newVersion: "0.2.2",
      existingTags: ["v0.2.1"],
    });
    expect(formatDecision(decideTagRelease(input))).toBe("tag v0.2.2");

    const skipped = await runTagRelease([], { cwd: dir });
    expect(skipped.exitCode).toBe(0);
    expect(skipped.stdout).toContain("tag v0.2.2");
  });
});

async function runTagRelease(
  args: string[],
  options: { cwd?: string } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "tag-release.ts"), ...args], {
    cwd: options.cwd ?? import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

async function tempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ado-stack-tag-release-"));
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
