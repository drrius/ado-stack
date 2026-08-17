import { describe, expect, test } from "bun:test";
import type { StackState } from "../../src/state/schema.ts";
import { createTempRepo, runCli, writeCommit } from "../helpers/repo.ts";

describe("status sync flags", () => {
  test("reports local/remote diverge from the live branch tip", async () => {
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
    } finally {
      await repo.cleanup();
    }
  });
});
