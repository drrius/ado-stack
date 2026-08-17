import { describe, expect, test } from "bun:test";
import { RestackConflictError, executeRestackStep } from "../../src/stack/restack.ts";
import type { StackState } from "../../src/state/schema.ts";
import { createTempRepo, runCli, writeCommit } from "../helpers/repo.ts";

describe("restack conflicts", () => {
  test("stops and leaves git rebase state", async () => {
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
      await writeCommit(repo.git, "file.txt", "parent\n", "A");
      await runCli(["create", "B"], { cwd: repo.dir });
      await writeCommit(repo.git, "file.txt", "child\n", "B");
      await repo.git.checkout("A");
      await writeCommit(repo.git, "file.txt", "parent-changed\n", "A2");

      const state = (await Bun.file(`${repo.dir}/.git/ado-stack/state.json`).json()) as StackState;
      const oldB = await repo.git.getBranchTip("B");
      try {
        await executeRestackStep({
          git: repo.git,
          state,
          step: {
            branch: "B",
            onto: "A",
            ontoSha: await repo.git.getBranchTip("A"),
            oldBase: state.branches.B!.lastRestackBase,
            preRebaseTip: oldB,
            status: "pending",
          },
        });
        throw new Error("expected conflict");
      } catch (error) {
        expect(error).toBeInstanceOf(RestackConflictError);
        expect(await repo.git.rebaseInProgress()).toBe(true);
        expect(error instanceof RestackConflictError && error.message).toContain(
          "restack --continue",
        );
        expect(error instanceof RestackConflictError && error.message).toContain("did not reset");
      }
    } finally {
      if (await repo.git.rebaseInProgress()) {
        await repo.git.abortRebase();
      }
      await repo.cleanup();
    }
  });
});
