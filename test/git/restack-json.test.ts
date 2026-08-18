import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { RestackStatusReport } from "../../src/commands/restack-events.ts";
import { createTempRepo, runCli, writeCommit } from "../helpers/repo.ts";

function events(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

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

describe("restack --json", () => {
  test("streams events through conflict, status, continue, and up-to-date", async () => {
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
      const conflictEvents = events(conflicted.stdout);
      expect(conflictEvents.map((event) => event.event)).toEqual([
        "plan",
        "step-start",
        "conflict",
      ]);
      const conflict = conflictEvents[2] as {
        branch: string;
        files: string[];
        worktreePath: string;
        blocked: string[];
      };
      expect(conflict.branch).toBe("B");
      expect(conflict.files).toEqual(["file.txt"]);
      expect(conflict.blocked).toContain("B");
      expect(conflict.worktreePath.length).toBeGreaterThan(0);
      // Human guidance stays on stderr so stdout is pure NDJSON.
      expect(conflicted.stderr).toContain("restack --continue");

      const status = await runCli(["restack", "--status", "--json"], { cwd: repo.dir });
      expect(status.exitCode).toBe(0);
      const report = JSON.parse(status.stdout) as RestackStatusReport;
      expect(report.conflictBranch).toBe("B");
      expect(report.plan?.steps.map((step) => [step.branch, step.status])).toEqual([
        ["B", "conflict"],
      ]);
      expect(report.rebase.inProgress).toBe(true);
      if (report.rebase.inProgress) {
        expect(report.rebase.conflictedFiles).toEqual(["file.txt"]);
        expect(report.rebase.worktreePath.length).toBeGreaterThan(0);
      }

      await Bun.write(join(repo.dir, "file.txt"), "parent-changed\nchild\n");
      await repo.git.run(["add", "--", "file.txt"]);
      await repo.git.continueRebase();

      const finished = await runCli(["restack", "--continue", "--json"], { cwd: repo.dir });
      expect(finished.exitCode).toBe(0);
      const finishedEvents = events(finished.stdout);
      expect(finishedEvents[0]).toEqual({ event: "step-done", branch: "B", onto: "A" });
      expect(finishedEvents.at(-1)?.event).toBe("done");

      const clean = await runCli(["restack", "--json"], { cwd: repo.dir });
      expect(clean.exitCode).toBe(0);
      expect(events(clean.stdout)).toEqual([{ event: "up-to-date" }]);

      const idleStatus = await runCli(["restack", "--status", "--json"], { cwd: repo.dir });
      const idleReport = JSON.parse(idleStatus.stdout) as RestackStatusReport;
      expect(idleReport.plan).toBeNull();
      expect(idleReport.conflictBranch).toBeNull();
      expect(idleReport.rebase.inProgress).toBe(false);
    } finally {
      if (await repo.git.rebaseInProgress()) {
        await repo.git.abortRebase();
      }
      await bare.cleanup();
      await repo.cleanup();
    }
  }, 60_000);

  test("abort emits an aborted event and refuses --status combinations", async () => {
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

      const mixed = await runCli(["restack", "--status", "--continue"], { cwd: repo.dir });
      expect(mixed.exitCode).not.toBe(0);
      expect(mixed.stderr).toContain("--status alone");

      const aborted = await runCli(["restack", "--abort", "--json"], { cwd: repo.dir });
      expect(aborted.exitCode).toBe(0);
      expect(events(aborted.stdout)).toEqual([{ event: "aborted" }]);
      expect(await repo.git.rebaseInProgress()).toBe(false);
    } finally {
      if (await repo.git.rebaseInProgress()) {
        await repo.git.abortRebase();
      }
      await bare.cleanup();
      await repo.cleanup();
    }
  }, 60_000);
});
