import { describe, expect, test } from "bun:test";
import { type PullRequestSnapshot, assessBranch } from "../../src/stack/restack.ts";
import type { StackState } from "../../src/state/schema.ts";
import { createTempRepo, runCli, writeCommit } from "../helpers/repo.ts";

describe("restack onto fetched default branch", () => {
  test("uses origin/main when local main is stale after a squash", async () => {
    const bare = await createTempRepo({ bare: true });
    const repo = await createTempRepo();
    try {
      await repo.git.run(["remote", "add", "origin", bare.dir]);
      await repo.git.push("origin", "main", { setUpstream: true });
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
      await writeCommit(repo.git, "a.txt", "from-A\n", "A change");
      await runCli(["create", "B"], { cwd: repo.dir });
      await writeCommit(repo.git, "b.txt", "from-B\n", "B change");
      await repo.git.push("origin", "A", { setUpstream: true });
      await repo.git.push("origin", "B", { setUpstream: true });

      const worker = `${repo.dir}-squash`;
      expect(
        await Bun.spawn(["git", "clone", bare.dir, worker], { stdout: "pipe", stderr: "pipe" })
          .exited,
      ).toBe(0);
      for (const args of [
        ["config", "user.email", "squash@example.com"],
        ["config", "user.name", "squash"],
        ["config", "commit.gpgsign", "false"],
        ["checkout", "A"],
        ["checkout", "main"],
        ["merge", "--squash", "A"],
        ["commit", "-m", "squash A"],
        ["push", "origin", "main"],
      ]) {
        expect(
          await Bun.spawn(["git", "-C", worker, ...args], { stdout: "pipe", stderr: "pipe" })
            .exited,
        ).toBe(0);
      }

      await repo.git.fetch("origin");
      const localMain = await repo.git.getBranchTip("main");
      const originMain = await repo.git.getBranchTip("origin/main");
      expect(localMain).not.toBe(originMain);

      const state = (await Bun.file(`${repo.dir}/.git/ado-stack/state.json`).json()) as StackState;
      state.branches.A!.pullRequestId = 1;
      state.branches.B!.pullRequestId = 2;
      const pullRequests = new Map<number, PullRequestSnapshot>([
        [1, { id: 1, status: "completed", sourceBranch: "A", targetBranch: "main" }],
        [2, { id: 2, status: "active", sourceBranch: "B", targetBranch: "A" }],
      ]);
      const assessment = await assessBranch({ git: repo.git, state, branch: "B", pullRequests });
      expect(assessment.effectiveParent).toBe("main");
      expect(assessment.ontoSha).toBe(originMain);
      expect(assessment.ontoSha).not.toBe(localMain);
    } finally {
      await repo.cleanup();
      await bare.cleanup();
    }
  }, 30_000);
});
