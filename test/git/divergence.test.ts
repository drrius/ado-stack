import { describe, expect, test } from "bun:test";
import { assertSafeRewrite } from "../../src/stack/restack.ts";
import type { StackState } from "../../src/state/schema.ts";
import { createTempRepo, runCli, writeCommit } from "../helpers/repo.ts";

describe("remote divergence", () => {
  test("refuses to overwrite an unexpected remote commit", async () => {
    const bare = await createTempRepo({ bare: true });
    const cloneA = await createTempRepo();
    try {
      await cloneA.git.run(["remote", "add", "origin", bare.dir]);
      await cloneA.git.push("origin", "main", { setUpstream: true });
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
        { cwd: cloneA.dir },
      );
      await runCli(["create", "B"], { cwd: cloneA.dir });
      const bSha = await writeCommit(cloneA.git, "b.txt", "local\n", "B local");
      await cloneA.git.push("origin", "B", { setUpstream: true });

      const cloneBDir = `${cloneA.dir}-other`;
      await Bun.spawn(["git", "clone", bare.dir, cloneBDir], { stdout: "pipe", stderr: "pipe" })
        .exited;
      const other = await Bun.spawn(["git", "-C", cloneBDir, "checkout", "-b", "B", "origin/B"], {
        stdout: "pipe",
        stderr: "pipe",
      }).exited;
      expect(other).toBe(0);
      await Bun.spawn(["git", "-C", cloneBDir, "config", "user.email", "other@example.com"], {
        stdout: "pipe",
        stderr: "pipe",
      }).exited;
      await Bun.spawn(["git", "-C", cloneBDir, "config", "user.name", "other"], {
        stdout: "pipe",
        stderr: "pipe",
      }).exited;
      await Bun.write(`${cloneBDir}/extra.txt`, "remote extra\n");
      await Bun.spawn(["git", "-C", cloneBDir, "add", "extra.txt"], {
        stdout: "pipe",
        stderr: "pipe",
      }).exited;
      await Bun.spawn(["git", "-C", cloneBDir, "commit", "-m", "unexpected"], {
        stdout: "pipe",
        stderr: "pipe",
      }).exited;
      const push = await Bun.spawn(["git", "-C", cloneBDir, "push", "origin", "B"], {
        stdout: "pipe",
        stderr: "pipe",
      }).exited;
      expect(push).toBe(0);

      await cloneA.git.fetch("origin");
      const state = (await Bun.file(
        `${cloneA.dir}/.git/ado-stack/state.json`,
      ).json()) as StackState;
      state.branches.B!.lastKnownRemoteTip = bSha;
      await expect(
        assertSafeRewrite({
          git: cloneA.git,
          state,
          branch: "B",
          remoteName: "origin",
        }),
      ).rejects.toThrow(/No remote history was overwritten/);
    } finally {
      await cloneA.cleanup();
      await bare.cleanup();
    }
  });
});
