import { describe, expect, test } from "bun:test";
import { planRestack } from "../../src/stack/restack.ts";
import type { StackState } from "../../src/state/schema.ts";
import { createTempRepo, runCli, writeCommit } from "../helpers/repo.ts";

describe("forest restack", () => {
  test("rebases parent before child and leaves a sibling untouched on conflict", async () => {
    const repo = await createTempRepo();
    try {
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
        { cwd: repo.dir },
      );
      await runCli(["create", "A"], { cwd: repo.dir });
      await writeCommit(repo.git, "a.txt", "A\n", "A");
      await runCli(["create", "A-child"], { cwd: repo.dir });
      await writeCommit(repo.git, "file.txt", "child\n", "A-child");
      await runCli(["checkout", "main"], { cwd: repo.dir });
      await runCli(["create", "B"], { cwd: repo.dir });
      await writeCommit(repo.git, "b.txt", "B\n", "B");

      await repo.git.checkout("A");
      await writeCommit(repo.git, "file.txt", "parent\n", "A2");
      await repo.git.checkout("main");
      await writeCommit(repo.git, "trunk.txt", "move\n", "trunk");

      const bare = await createTempRepo({ bare: true });
      await repo.git.run(["remote", "add", "origin", bare.dir]);
      await repo.git.push("origin", "main", { setUpstream: true });

      const state = (await Bun.file(`${repo.dir}/.git/ado-stack/state.json`).json()) as StackState;
      const plan = await planRestack({ git: repo.git, state, pullRequests: new Map() });
      expect(plan.steps.map((step) => step.branch)).toEqual(["A", "A-child", "B"]);

      const bBefore = await repo.git.getBranchTip("B");
      const restack = await runCli(["restack"], { cwd: repo.dir });
      expect(restack.exitCode).not.toBe(0);
      expect(restack.stderr).toContain("A-child");
      expect(restack.stderr).toContain("Untouched");
      expect(restack.stderr).toContain("B");
      expect(await repo.git.rebaseInProgress()).toBe(true);
      expect(await repo.git.getBranchTip("B")).toBe(bBefore);
      expect(restack.stderr).not.toContain("Restacked B");
      await bare.cleanup();
    } finally {
      if (await repo.git.rebaseInProgress()) {
        await repo.git.abortRebase();
      }
      await repo.cleanup();
    }
  }, 30_000);

  test("create from a parent that already has children records a sibling", async () => {
    const repo = await createTempRepo();
    try {
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
        { cwd: repo.dir },
      );
      await runCli(["create", "first"], { cwd: repo.dir });
      await writeCommit(repo.git, "first.txt", "1\n", "first");
      await runCli(["checkout", "main"], { cwd: repo.dir });
      const sibling = await runCli(["create", "second"], { cwd: repo.dir });
      expect(sibling.exitCode).toBe(0);
      const state = (await Bun.file(`${repo.dir}/.git/ado-stack/state.json`).json()) as StackState;
      expect(state.branches.first?.parent).toBe("main");
      expect(state.branches.second?.parent).toBe("main");
    } finally {
      await repo.cleanup();
    }
  }, 30_000);
});
