import { describe, expect, test } from "bun:test";
import type { StackState } from "../../src/state/schema.ts";
import { createTempRepo, runCli, writeCommit } from "../helpers/repo.ts";

describe("status sync flags", () => {
  test("reports local/remote diverge from the live branch tip", async () => {
    const repo = await createTempRepo();
    try {
      const initialized = await runCli(
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
      expect(initialized.exitCode).toBe(0);
      expect(initialized.stdout).toContain("Wrote local ado-stack state");
      expect(initialized.stdout).toContain("Next: ado-stack auth login");
      expect(initialized.stdout).not.toContain("Initialized ado-stack");
      expect(initialized.stderr).toContain("warning: Azure DevOps metadata was not loaded");
      await runCli(["create", "A"], { cwd: repo.dir });
      const submitted = await writeCommit(repo.git, "a.txt", "one\n", "A1");
      const state = (await Bun.file(`${repo.dir}/.git/ado-stack/state.json`).json()) as StackState;
      state.branches.A!.lastKnownRemoteTip = submitted;
      state.branches.A!.lastLocalTip = submitted;
      state.branches.A!.pullRequestId = 9;
      await Bun.write(
        `${repo.dir}/.git/ado-stack/state.json`,
        `${JSON.stringify(state, null, 2)}\n`,
      );
      await writeCommit(repo.git, "a.txt", "two\n", "A2");
      const status = await runCli(["status"], { cwd: repo.dir });
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toContain("local/remote diverge");
      expect(status.stdout).toContain("Not authenticated to Azure DevOps.");
      const row = status.stdout.split("\n").find((line) => line.includes("#9"));
      expect(row).toContain("UNKNOWN");
      expect(row).not.toContain("LOCAL");
    } finally {
      await repo.cleanup();
    }
  });

  test("reports restack needed when origin/main moved and local main is stale", async () => {
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
      const worker = `${repo.dir}-main`;
      expect(
        await Bun.spawn(["git", "clone", bare.dir, worker], { stdout: "pipe", stderr: "pipe" })
          .exited,
      ).toBe(0);
      for (const args of [
        ["config", "user.email", "other@example.com"],
        ["config", "user.name", "other"],
        ["config", "commit.gpgsign", "false"],
        ["checkout", "main"],
      ]) {
        expect(
          await Bun.spawn(["git", "-C", worker, ...args], { stdout: "pipe", stderr: "pipe" })
            .exited,
        ).toBe(0);
      }
      await Bun.write(`${worker}/trunk.txt`, "remote main\n");
      for (const args of [
        ["add", "trunk.txt"],
        ["commit", "-m", "advance main"],
        ["push", "origin", "main"],
      ]) {
        expect(
          await Bun.spawn(["git", "-C", worker, ...args], { stdout: "pipe", stderr: "pipe" })
            .exited,
        ).toBe(0);
      }
      const status = await runCli(["status"], { cwd: repo.dir });
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toContain("restack needed");
    } finally {
      await repo.cleanup();
      await bare.cleanup();
    }
  }, 30_000);
});
