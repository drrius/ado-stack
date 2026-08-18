import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitRepo } from "../../src/git/git.ts";
import { createTempRepo, runCli, writeCommit } from "../helpers/repo.ts";

async function seedStack(dir: string): Promise<void> {
  const init = await runCli(
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
  expect(init.exitCode).toBe(0);
}

async function addOrigin(repo: { dir: string; git: GitRepo }): Promise<{
  cleanup: () => Promise<void>;
}> {
  const bare = await createTempRepo({ bare: true });
  await repo.git.run(["remote", "add", "origin", bare.dir]);
  await repo.git.push("origin", "main", { setUpstream: true });
  return { cleanup: bare.cleanup };
}

async function withWorktree(
  repo: { git: GitRepo },
  branch: string,
  fn: (worktree: { dir: string; git: GitRepo }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ados-wt-"));
  await repo.git.run(["worktree", "add", dir, branch]);
  try {
    await fn({ dir, git: new GitRepo(dir) });
  } finally {
    await repo.git.run(["worktree", "remove", "--force", dir]);
    await rm(dir, { recursive: true, force: true });
  }
}

describe("restack and extra worktrees", () => {
  test("refuses a mixed forest before rebasing a free sibling", async () => {
    const repo = await createTempRepo();
    try {
      await seedStack(repo.dir);
      await runCli(["create", "A"], { cwd: repo.dir });
      await writeCommit(repo.git, "a.txt", "A\n", "A");
      await runCli(["create", "B"], { cwd: repo.dir });
      await writeCommit(repo.git, "b.txt", "B\n", "B");
      await repo.git.checkout("main");
      await writeCommit(repo.git, "trunk.txt", "move\n", "trunk");
      const origin = await addOrigin(repo);
      const aBefore = await repo.git.getBranchTip("A");
      const bBefore = await repo.git.getBranchTip("B");
      try {
        await withWorktree(repo, "B", async (worktree) => {
          await Bun.write(join(worktree.dir, "dirty.txt"), "held\n");
          const listed = (await repo.git.listWorktrees()).find((item) => item.branch === "B");
          const restack = await runCli(["restack"], { cwd: repo.dir });
          expect(restack.exitCode).not.toBe(0);
          expect(restack.stderr).toContain("B");
          if (listed === undefined) {
            throw new Error("expected git worktree list to name B");
          }
          expect(restack.stderr).toContain(listed.path);
          expect(restack.stderr).toContain("No branches were rebased or pushed.");
          expect(restack.stdout).not.toContain("Restacked");
          expect(await repo.git.getBranchTip("A")).toBe(aBefore);
          expect(await repo.git.getBranchTip("B")).toBe(bBefore);
          expect(await repo.git.currentBranch()).toBe("main");
          expect(
            await Bun.file(`${repo.dir}/.git/ado-stack/restack-in-progress.json`).exists(),
          ).toBe(false);
        });
      } finally {
        await origin.cleanup();
      }
    } finally {
      await repo.cleanup();
    }
  }, 30_000);

  test("keeps the invoking checkout after a successful restack", async () => {
    const repo = await createTempRepo();
    try {
      await seedStack(repo.dir);
      await runCli(["create", "A"], { cwd: repo.dir });
      await writeCommit(repo.git, "a.txt", "A\n", "A");
      await repo.git.checkout("main");
      await writeCommit(repo.git, "trunk.txt", "move\n", "trunk");
      const origin = await addOrigin(repo);
      try {
        const restack = await runCli(["restack"], { cwd: repo.dir });
        expect(restack.exitCode).toBe(0);
        expect(restack.stdout).toContain("Restacked A");
        expect(await repo.git.currentBranch()).toBe("main");
        expect(await repo.git.isAncestor(await repo.git.getBranchTip("main"), "A")).toBe(true);
      } finally {
        await origin.cleanup();
      }
    } finally {
      await repo.cleanup();
    }
  }, 30_000);

  test("rebases a clean held branch in its worktree", async () => {
    const repo = await createTempRepo();
    try {
      await seedStack(repo.dir);
      await runCli(["create", "A"], { cwd: repo.dir });
      await writeCommit(repo.git, "a.txt", "A\n", "A");
      await runCli(["create", "B"], { cwd: repo.dir });
      await writeCommit(repo.git, "b.txt", "B\n", "B");
      await repo.git.checkout("main");
      await writeCommit(repo.git, "trunk.txt", "move\n", "trunk");
      const origin = await addOrigin(repo);
      try {
        await withWorktree(repo, "B", async (worktree) => {
          const restack = await runCli(["restack"], { cwd: repo.dir });
          expect(restack.exitCode).toBe(0);
          expect(restack.stdout).toContain("Restacked A");
          expect(restack.stdout).toContain("Restacked B");
          expect(await repo.git.currentBranch()).toBe("main");
          expect(await worktree.git.currentBranch()).toBe("B");
          expect(await repo.git.isAncestor(await repo.git.getBranchTip("main"), "A")).toBe(true);
          expect(await repo.git.isAncestor(await repo.git.getBranchTip("A"), "B")).toBe(true);
        });
      } finally {
        await origin.cleanup();
      }
    } finally {
      await repo.cleanup();
    }
  }, 30_000);

  test("abort does not touch a rebase in an unrelated worktree", async () => {
    const repo = await createTempRepo();
    try {
      await seedStack(repo.dir);
      await runCli(["create", "A"], { cwd: repo.dir });
      await writeCommit(repo.git, "a.txt", "A\n", "A");
      await repo.git.checkout("main");
      await writeCommit(repo.git, "trunk.txt", "move\n", "trunk");
      const origin = await addOrigin(repo);
      try {
        await repo.git.createBranch("scratch/other", "main");
        await withWorktree(repo, "scratch/other", async (worktree) => {
          await writeCommit(worktree.git, "conflict.txt", "other\n", "other");
          await repo.git.checkout("main");
          await writeCommit(repo.git, "conflict.txt", "main\n", "main-change");
          await worktree.git.run(["rebase", "main"], { allowFailure: true });
          expect(await worktree.git.rebaseInProgress()).toBe(true);
          const aborted = await runCli(["restack", "--abort"], { cwd: repo.dir });
          expect(aborted.exitCode).toBe(0);
          expect(await worktree.git.rebaseInProgress()).toBe(true);
        });
      } finally {
        await origin.cleanup();
      }
    } finally {
      await repo.cleanup();
    }
  }, 30_000);
});
