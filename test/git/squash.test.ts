import { describe, expect, test } from "bun:test";
import { executeRestackStep } from "../../src/stack/restack.ts";
import { uniqueCommits } from "../../src/stack/ownership.ts";
import type { StackState } from "../../src/state/schema.ts";
import { createTempRepo, runCli, writeCommit } from "../helpers/repo.ts";

describe("squash merge restack", () => {
  test("does not replay A onto B after A is squashed into main", async () => {
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
          "--default-branch",
          "main",
        ],
        { cwd: repo.dir },
      );
      await runCli(["create", "A"], { cwd: repo.dir });
      await writeCommit(repo.git, "a.txt", "from-A\n", "A change");
      await runCli(["create", "B"], { cwd: repo.dir });
      await writeCommit(repo.git, "b.txt", "from-B\n", "B change");
      await runCli(["create", "C"], { cwd: repo.dir });
      await writeCommit(repo.git, "c.txt", "from-C\n", "C change");

      const aTip = await repo.git.getBranchTip("A");
      await repo.git.checkout("main");
      await repo.git.run(["merge", "--squash", "A"]);
      await repo.git.run(["commit", "-m", "squash A"]);
      const mainTip = await repo.git.getBranchTip("main");
      expect(await repo.git.isAncestor(aTip, "main")).toBe(false);

      const state = (await Bun.file(`${repo.dir}/.git/ado-stack/state.json`).json()) as StackState;
      const bBefore = state.branches.B!;
      const cBefore = state.branches.C!;

      const afterB = await executeRestackStep({
        git: repo.git,
        state,
        step: {
          branch: "B",
          onto: "main",
          ontoSha: mainTip,
          oldBase: bBefore.lastRestackBase,
          preRebaseTip: await repo.git.getBranchTip("B"),
          retargetPrTo: "main",
          status: "pending",
        },
      });
      const afterC = await executeRestackStep({
        git: repo.git,
        state: afterB,
        step: {
          branch: "C",
          onto: "B",
          ontoSha: await repo.git.getBranchTip("B"),
          oldBase: cBefore.lastRestackBase,
          preRebaseTip: await repo.git.getBranchTip("C"),
          status: "pending",
        },
      });

      expect(afterC.branches.A).toBeUndefined();
      expect(afterC.branches.B?.parent).toBe("main");
      const bFiles = await uniqueCommits(repo.git, "B", afterC.branches.B!);
      const cFiles = await uniqueCommits(repo.git, "C", afterC.branches.C!);
      expect(bFiles.commits.map((commit) => commit.subject)).toEqual(["B change"]);
      expect(cFiles.commits.map((commit) => commit.subject)).toEqual(["C change"]);
      expect(await Bun.file(`${repo.dir}/a.txt`).text()).toBe("from-A\n");
      await repo.git.checkout("B");
      expect(await Bun.file(`${repo.dir}/b.txt`).text()).toBe("from-B\n");
      expect(await Bun.file(`${repo.dir}/c.txt`).exists()).toBe(false);
      const bFromMain = await repo.git.getCommitsBetween(mainTip, "B");
      expect(bFromMain.map((commit) => commit.subject)).toEqual(["B change"]);
    } finally {
      await repo.cleanup();
    }
  });
});
