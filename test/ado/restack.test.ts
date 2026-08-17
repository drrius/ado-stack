import { describe, expect, test } from "bun:test";
import { decodeStackProperties } from "../../src/ado/properties.ts";
import type { StackState } from "../../src/state/schema.ts";
import { createTempRepo, runCli, writeCommit } from "../helpers/repo.ts";
import { FakeAzureDevOps } from "./fake-server.ts";

describe("restack against fake Azure DevOps", () => {
  test("retargets onto origin/main and updates PR properties after a squash", async () => {
    const repo = await createTempRepo();
    const fake = new FakeAzureDevOps({
      organization: "example",
      project: "Platform",
      repository: "app",
      token: "test-pat",
    });
    const env = { ADO_STACK_PAT: "test-pat" };
    try {
      const origin = await fake.listen();
      await runCli(
        [
          "init",
          "--organization",
          origin,
          "--project",
          "Platform",
          "--repository",
          "app",
          "--default-branch",
          "main",
        ],
        { cwd: repo.dir, env },
      );
      await runCli(["create", "schema"], { cwd: repo.dir, env });
      await writeCommit(repo.git, "schema.sql", "create table t;\n", "add schema");
      await runCli(["create", "api"], { cwd: repo.dir, env });
      await writeCommit(repo.git, "api.ts", "export const api = 1;\n", "add api");

      const bare = await createTempRepo({ bare: true });
      await repo.git.run(["remote", "add", "origin", bare.dir]);
      await repo.git.push("origin", "main", { setUpstream: true });
      const submitted = await runCli(["submit"], { cwd: repo.dir, env });
      expect(submitted.exitCode).toBe(0);

      const schemaPr = [...fake.pullRequests.values()].find((pr) =>
        pr.sourceRefName.endsWith("schema"),
      );
      const apiPr = [...fake.pullRequests.values()].find((pr) => pr.sourceRefName.endsWith("api"));
      expect(schemaPr).toBeDefined();
      expect(apiPr).toBeDefined();
      if (!schemaPr || !apiPr) {
        throw new Error("expected stacked PRs");
      }
      schemaPr.status = "completed";

      const worker = `${repo.dir}-squash`;
      expect(
        await Bun.spawn(["git", "clone", bare.dir, worker], { stdout: "pipe", stderr: "pipe" })
          .exited,
      ).toBe(0);
      for (const args of [
        ["config", "user.email", "squash@example.com"],
        ["config", "user.name", "squash"],
        ["config", "commit.gpgsign", "false"],
        ["fetch", "origin"],
        ["checkout", "schema"],
        ["checkout", "main"],
        ["merge", "--squash", "schema"],
        ["commit", "-m", "squash schema"],
        ["push", "origin", "main"],
      ]) {
        expect(
          await Bun.spawn(["git", "-C", worker, ...args], { stdout: "pipe", stderr: "pipe" })
            .exited,
        ).toBe(0);
      }

      const localMainBefore = await repo.git.getBranchTip("main");
      const restack = await runCli(["restack"], { cwd: repo.dir, env });
      expect(restack.exitCode).toBe(0);
      expect(restack.stdout).toContain(`${apiPr.pullRequestId}`);
      expect(await repo.git.getBranchTip("main")).toBe(localMainBefore);
      expect(await repo.git.getBranchTip("origin/main")).not.toBe(localMainBefore);

      await repo.git.checkout("api");
      expect(await Bun.file(`${repo.dir}/schema.sql`).text()).toBe("create table t;\n");
      expect(await Bun.file(`${repo.dir}/api.ts`).text()).toBe("export const api = 1;\n");
      const unique = await repo.git.getCommitsBetween("origin/main", "api");
      expect(unique.map((commit) => commit.subject)).toEqual(["add api"]);

      expect(apiPr.targetRefName).toBe("refs/heads/main");
      expect(decodeStackProperties(apiPr.properties)?.parent).toBe("main");
      const state = (await Bun.file(`${repo.dir}/.git/ado-stack/state.json`).json()) as StackState;
      expect(state.branches.schema).toBeUndefined();
      expect(state.branches.api?.parent).toBe("main");
      await bare.cleanup();
    } finally {
      fake.stop();
      await repo.cleanup();
    }
  }, 30_000);
});
