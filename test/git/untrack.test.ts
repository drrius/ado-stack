import { describe, expect, test } from "bun:test";
import type { StackState } from "../../src/state/schema.ts";
import { createTempRepo, runCli, writeCommit } from "../helpers/repo.ts";

async function initStack(dir: string): Promise<void> {
  await runCli(
    [
      "init",
      "--organization",
      "https://dev.azure.com/example",
      "--project",
      "P",
      "--repository",
      "R",
    ],
    { cwd: dir },
  );
}

async function readState(dir: string): Promise<StackState> {
  return (await Bun.file(`${dir}/.git/ado-stack/state.json`).json()) as StackState;
}

describe("untrack", () => {
  test("removes a leaf from state, refuses parents and unknowns", async () => {
    const repo = await createTempRepo();
    try {
      await initStack(repo.dir);
      await runCli(["create", "A"], { cwd: repo.dir });
      await writeCommit(repo.git, "a.txt", "A\n", "A");
      await runCli(["create", "B"], { cwd: repo.dir });
      await writeCommit(repo.git, "b.txt", "B\n", "B");

      // A parent with a tracked child is refused, naming the child.
      const parent = await runCli(["untrack", "A"], { cwd: repo.dir });
      expect(parent.exitCode).not.toBe(0);
      expect(parent.stderr).toContain("stacked on it");
      expect(parent.stderr).toContain("B");

      const unknown = await runCli(["untrack", "nope"], { cwd: repo.dir });
      expect(unknown.exitCode).not.toBe(0);
      expect(unknown.stderr).toContain("not tracked");

      const missing = await runCli(["untrack"], { cwd: repo.dir });
      expect(missing.exitCode).not.toBe(0);
      expect(missing.stderr).toContain("Usage");

      // Leaf first, then the now-childless parent.
      const leaf = await runCli(["untrack", "B"], { cwd: repo.dir });
      expect(leaf.exitCode).toBe(0);
      expect(leaf.stdout).toContain("Untracked");
      expect(Object.keys((await readState(repo.dir)).branches)).toEqual(["A"]);

      const root = await runCli(["untrack", "A"], { cwd: repo.dir });
      expect(root.exitCode).toBe(0);
      expect(Object.keys((await readState(repo.dir)).branches)).toEqual([]);

      // The Git branches themselves are untouched.
      expect(await repo.git.branchExists("A")).toBe(true);
      expect(await repo.git.branchExists("B")).toBe(true);
    } finally {
      await repo.cleanup();
    }
  }, 30_000);

  test("refuses while a restack plan is in progress", async () => {
    const repo = await createTempRepo();
    const bare = await createTempRepo({ bare: true });
    try {
      await initStack(repo.dir);
      await runCli(["create", "A"], { cwd: repo.dir });
      await writeCommit(repo.git, "file.txt", "parent\n", "A");
      await runCli(["create", "B"], { cwd: repo.dir });
      await writeCommit(repo.git, "file.txt", "child\n", "B");
      await repo.git.checkout("A");
      await writeCommit(repo.git, "file.txt", "parent-changed\n", "A2");
      await repo.git.run(["remote", "add", "origin", bare.dir]);
      await repo.git.push("origin", "main", { setUpstream: true });

      const conflicted = await runCli(["restack", "--json"], { cwd: repo.dir });
      expect(conflicted.exitCode).not.toBe(0);

      const blocked = await runCli(["untrack", "B"], { cwd: repo.dir });
      expect(blocked.exitCode).not.toBe(0);
      expect(blocked.stderr).toContain("restack is in progress");

      await runCli(["restack", "--abort"], { cwd: repo.dir });
      const after = await runCli(["untrack", "B"], { cwd: repo.dir });
      expect(after.exitCode).toBe(0);
    } finally {
      if (await repo.git.rebaseInProgress()) {
        await repo.git.abortRebase();
      }
      await bare.cleanup();
      await repo.cleanup();
    }
  }, 60_000);
});
