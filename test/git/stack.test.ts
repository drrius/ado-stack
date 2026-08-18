import { describe, expect, test } from "bun:test";
import { uniqueCommits } from "../../src/stack/ownership.ts";
import { executeRestackStep, planRestack } from "../../src/stack/restack.ts";
import type { StackState } from "../../src/state/schema.ts";
import { createTempRepo, runCli, writeCommit } from "../helpers/repo.ts";

async function seedStack(dir: string): Promise<void> {
  const init = await runCli(
    [
      "init",
      "--organization",
      "https://dev.azure.com/example",
      "--project",
      "Platform",
      "--repository",
      "app",
      "--default-branch",
      "main",
    ],
    { cwd: dir },
  );
  expect(init.exitCode).toBe(0);
}

describe("real git linear stack", () => {
  test("create records commit ownership for A, B, C", async () => {
    const repo = await createTempRepo();
    try {
      await seedStack(repo.dir);
      expect((await runCli(["create", "A"], { cwd: repo.dir })).exitCode).toBe(0);
      await writeCommit(repo.git, "a.txt", "A\n", "add A");
      expect((await runCli(["create", "B"], { cwd: repo.dir })).exitCode).toBe(0);
      await writeCommit(repo.git, "b.txt", "B\n", "add B");
      expect((await runCli(["create", "C"], { cwd: repo.dir })).exitCode).toBe(0);
      await writeCommit(repo.git, "c.txt", "C\n", "add C");

      const status = await runCli(["status"], { cwd: repo.dir });
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toContain("C");
      expect(status.stdout).toContain("Current: C");

      const up = await runCli(["down"], { cwd: repo.dir });
      expect(up.exitCode).toBe(0);
      expect(await repo.git.currentBranch()).toBe("B");
      expect((await runCli(["up"], { cwd: repo.dir })).exitCode).toBe(0);
      expect(await repo.git.currentBranch()).toBe("C");

      const stateRaw = await Bun.file(`${repo.git.cwd}/.git/ado-stack/state.json`).json();
      const state = stateRaw as StackState;
      const a = await uniqueCommits(repo.git, "A", state.branches.A!);
      const b = await uniqueCommits(repo.git, "B", state.branches.B!);
      const c = await uniqueCommits(repo.git, "C", state.branches.C!);
      expect(a.commits.map((commit) => commit.subject)).toEqual(["add A"]);
      expect(b.commits.map((commit) => commit.subject)).toEqual(["add B"]);
      expect(c.commits.map((commit) => commit.subject)).toEqual(["add C"]);
    } finally {
      await repo.cleanup();
    }
  }, 30_000);

  test("restack after parent receives new commits keeps child ranges", async () => {
    const repo = await createTempRepo();
    try {
      await seedStack(repo.dir);
      await runCli(["create", "A"], { cwd: repo.dir });
      await writeCommit(repo.git, "a.txt", "A1\n", "A1");
      await runCli(["create", "B"], { cwd: repo.dir });
      await writeCommit(repo.git, "b.txt", "B1\n", "B1");
      await runCli(["create", "C"], { cwd: repo.dir });
      await writeCommit(repo.git, "c.txt", "C1\n", "C1");

      await repo.git.checkout("A");
      await writeCommit(repo.git, "a.txt", "A1\nA2\n", "A2");

      const state = (await Bun.file(`${repo.dir}/.git/ado-stack/state.json`).json()) as StackState;
      state.branches.A!.lastLocalTip = await repo.git.getBranchTip("A");
      const plan = await planRestack({ git: repo.git, state, pullRequests: new Map() });
      expect(plan.steps.map((step) => step.branch)).toEqual(["B", "C"]);
      let next = state;
      for (const step of plan.steps) {
        const live = {
          ...step,
          ontoSha: await repo.git.getBranchTip(step.onto),
          oldBase: next.branches[step.branch]!.lastRestackBase,
          preRebaseTip: await repo.git.getBranchTip(step.branch),
        };
        next = await executeRestackStep({ git: repo.git, state: next, step: live });
      }
      const b = await uniqueCommits(repo.git, "B", next.branches.B!);
      const c = await uniqueCommits(repo.git, "C", next.branches.C!);
      expect(b.commits.map((commit) => commit.subject)).toEqual(["B1"]);
      expect(c.commits.map((commit) => commit.subject)).toEqual(["C1"]);
      expect(await repo.git.isAncestor(await repo.git.getBranchTip("A"), "B")).toBe(true);
      expect(await repo.git.isAncestor(await repo.git.getBranchTip("B"), "C")).toBe(true);
      const bLog = await repo.git.getCommitsBetween(await repo.git.getBranchTip("main"), "B");
      expect(bLog.map((commit) => commit.subject)).toEqual(["A1", "A2", "B1"]);
    } finally {
      await repo.cleanup();
    }
  }, 30_000);

  test("restack after parent rebase keeps child changes", async () => {
    const repo = await createTempRepo();
    try {
      await seedStack(repo.dir);
      await runCli(["create", "A"], { cwd: repo.dir });
      await writeCommit(repo.git, "a.txt", "A\n", "A");
      await runCli(["create", "B"], { cwd: repo.dir });
      await writeCommit(repo.git, "b.txt", "B\n", "B");

      await repo.git.checkout("A");
      await repo.git.run(["commit", "--amend", "-m", "A rewritten"]);
      const state = (await Bun.file(`${repo.dir}/.git/ado-stack/state.json`).json()) as StackState;
      state.branches.A!.lastLocalTip = await repo.git.getBranchTip("A");
      const plan = await planRestack({ git: repo.git, state, pullRequests: new Map() });
      let next = state;
      for (const step of plan.steps) {
        const live = {
          ...step,
          ontoSha: await repo.git.getBranchTip(step.onto),
          oldBase: next.branches[step.branch]!.lastRestackBase,
          preRebaseTip: await repo.git.getBranchTip(step.branch),
        };
        next = await executeRestackStep({ git: repo.git, state: next, step: live });
      }
      expect(
        (await uniqueCommits(repo.git, "B", next.branches.B!)).commits.map((c) => c.subject),
      ).toEqual(["B"]);
      expect(await Bun.file(`${repo.dir}/b.txt`).text()).toBe("B\n");
    } finally {
      await repo.cleanup();
    }
  }, 30_000);

  test("create refuses to run with uncommitted tracked changes", async () => {
    const repo = await createTempRepo();
    try {
      await seedStack(repo.dir);
      await Bun.write(`${repo.dir}/README.md`, "dirty\n");
      const created = await runCli(["create", "A"], { cwd: repo.dir });
      expect(created.exitCode).not.toBe(0);
      expect(created.stderr).toContain("uncommitted");
      expect(await repo.git.currentBranch()).toBe("main");
    } finally {
      await repo.cleanup();
    }
  }, 30_000);
});
