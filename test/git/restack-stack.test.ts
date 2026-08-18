import { describe, expect, test } from "bun:test";
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

describe("restack --stack", () => {
  test("restacks only the tree containing the branch", async () => {
    const repo = await createTempRepo();
    const bare = await createTempRepo({ bare: true });
    try {
      await initStack(repo.dir);
      // Tree 1: A ← A-child. Tree 2: B (standalone).
      await runCli(["create", "A"], { cwd: repo.dir });
      await writeCommit(repo.git, "a.txt", "A\n", "A");
      await runCli(["create", "A-child"], { cwd: repo.dir });
      await writeCommit(repo.git, "a-child.txt", "child\n", "A-child");
      await runCli(["checkout", "main"], { cwd: repo.dir });
      await runCli(["create", "B"], { cwd: repo.dir });
      await writeCommit(repo.git, "b.txt", "B\n", "B");
      // Move trunk so every tree needs a restack.
      await repo.git.checkout("main");
      await writeCommit(repo.git, "trunk.txt", "move\n", "trunk");
      await repo.git.run(["remote", "add", "origin", bare.dir]);
      await repo.git.push("origin", "main", { setUpstream: true });

      const bBefore = await repo.git.getBranchTip("B");
      const mainTip = await repo.git.getBranchTip("main");

      // --stack accepts any branch in the tree; use the child to prove the
      // scope is the whole tree, not just the named branch's subtree.
      const scoped = await runCli(["restack", "--stack", "A-child", "--json"], { cwd: repo.dir });
      expect(scoped.exitCode).toBe(0);
      const doneBranches = scoped.stdout
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { event: string; branch?: string })
        .filter((event) => event.event === "step-done")
        .map((event) => event.branch);
      expect(doneBranches).toEqual(["A", "A-child"]);

      // Tree 1 moved onto the new trunk; B was left alone.
      expect(await repo.git.getMergeBase("A", "main")).toBe(mainTip);
      expect(await repo.git.getBranchTip("B")).toBe(bBefore);

      // B's tree can then be restacked on its own.
      const other = await runCli(["restack", "--stack", "B", "--json"], { cwd: repo.dir });
      expect(other.exitCode).toBe(0);
      expect(await repo.git.getMergeBase("B", "main")).toBe(mainTip);
    } finally {
      if (await repo.git.rebaseInProgress()) {
        await repo.git.abortRebase();
      }
      await bare.cleanup();
      await repo.cleanup();
    }
  }, 60_000);

  test("resolves short names against the configured branchPrefix", async () => {
    const repo = await createTempRepo();
    const bare = await createTempRepo({ bare: true });
    try {
      await initStack(repo.dir);
      await runCli(["config", "set", "branchPrefix", "dev/"], { cwd: repo.dir });
      await runCli(["create", "A"], { cwd: repo.dir });
      await writeCommit(repo.git, "a.txt", "A\n", "A");
      await repo.git.checkout("main");
      await writeCommit(repo.git, "trunk.txt", "move\n", "trunk");
      await repo.git.run(["remote", "add", "origin", bare.dir]);
      await repo.git.push("origin", "main", { setUpstream: true });

      const mainTip = await repo.git.getBranchTip("main");
      const scoped = await runCli(["restack", "--stack", "A", "--json"], { cwd: repo.dir });
      expect(scoped.exitCode).toBe(0);
      expect(scoped.stdout).toContain('"branch":"dev/A"');
      expect(await repo.git.getMergeBase("dev/A", "main")).toBe(mainTip);
    } finally {
      if (await repo.git.rebaseInProgress()) {
        await repo.git.abortRebase();
      }
      await bare.cleanup();
      await repo.cleanup();
    }
  }, 60_000);

  test("refuses unknown branches and in-progress flag combinations", async () => {
    const repo = await createTempRepo();
    const bare = await createTempRepo({ bare: true });
    try {
      await initStack(repo.dir);
      await runCli(["create", "A"], { cwd: repo.dir });
      await writeCommit(repo.git, "a.txt", "A\n", "A");
      await repo.git.run(["remote", "add", "origin", bare.dir]);
      await repo.git.push("origin", "main", { setUpstream: true });

      const unknown = await runCli(["restack", "--stack", "nope"], { cwd: repo.dir });
      expect(unknown.exitCode).not.toBe(0);
      expect(unknown.stderr).toContain("not tracked");

      for (const flag of ["--continue", "--abort", "--status"]) {
        const mixed = await runCli(["restack", "--stack", "A", flag], { cwd: repo.dir });
        expect(mixed.exitCode).not.toBe(0);
        expect(mixed.stderr).toContain("--stack cannot be combined");
      }

      const clean = await runCli(["restack", "--stack", "A", "--json"], { cwd: repo.dir });
      expect(clean.exitCode).toBe(0);
      expect(clean.stdout.trim()).toBe('{"event":"up-to-date"}');
    } finally {
      await bare.cleanup();
      await repo.cleanup();
    }
  }, 60_000);
});
