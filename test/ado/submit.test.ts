import { describe, expect, test } from "bun:test";
import { AdoClient } from "../../src/ado/client.ts";
import { humanDescription } from "../../src/ado/description.ts";
import { decodeStackProperties } from "../../src/ado/properties.ts";
import { createTempRepo, runCli, writeCommit } from "../helpers/repo.ts";
import { FakeAzureDevOps } from "./fake-server.ts";

describe("submit against fake Azure DevOps", () => {
  test("creates stacked PRs, properties, and preserves human description", async () => {
    const repo = await createTempRepo();
    const fake = new FakeAzureDevOps({
      organization: "example",
      project: "Platform",
      repository: "app",
      token: "test-pat",
    });
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
        { cwd: repo.dir, env: { ADO_STACK_PAT: "test-pat" } },
      );
      await runCli(["create", "schema"], { cwd: repo.dir, env: { ADO_STACK_PAT: "test-pat" } });
      await writeCommit(repo.git, "schema.sql", "create table t;\n", "add schema");
      await runCli(["create", "api"], { cwd: repo.dir, env: { ADO_STACK_PAT: "test-pat" } });
      await writeCommit(repo.git, "api.ts", "export const api = 1;\n", "add api");

      const bare = await createTempRepo({ bare: true });
      await repo.git.run(["remote", "add", "origin", bare.dir]);
      await repo.git.push("origin", "main", { setUpstream: true });

      await runCli(["checkout", "schema"], { cwd: repo.dir, env: { ADO_STACK_PAT: "test-pat" } });
      const first = await runCli(["submit", "--title", "Schema PR"], {
        cwd: repo.dir,
        env: { ADO_STACK_PAT: "test-pat" },
      });
      expect(first.exitCode).toBe(0);
      expect(first.stdout).toContain("PR #");
      expect(fake.pullRequests.size).toBe(2);

      const schemaPr = [...fake.pullRequests.values()].find((pr) =>
        pr.sourceRefName.endsWith("schema"),
      );
      const apiPr = [...fake.pullRequests.values()].find((pr) => pr.sourceRefName.endsWith("api"));
      expect(schemaPr?.targetRefName).toBe("refs/heads/main");
      expect(apiPr?.targetRefName).toBe("refs/heads/schema");
      expect(schemaPr?.title).toBe("Schema PR");
      expect(apiPr?.title).toBe("add api");

      if (schemaPr) {
        schemaPr.description = `Please review carefully.\n\n${schemaPr.description}`;
      }
      const second = await runCli(["submit"], {
        cwd: repo.dir,
        env: { ADO_STACK_PAT: "test-pat" },
      });
      expect(second.exitCode).toBe(0);
      expect(fake.pullRequests.size).toBe(2);
      expect(humanDescription(schemaPr?.description ?? "")).toContain("Please review carefully.");
      const meta = decodeStackProperties(schemaPr?.properties ?? {});
      expect(meta?.parent).toBe("main");
      expect(meta?.branch).toBe("schema");
      expect(apiPr?.description).toContain("**add api**");
      expect(apiPr?.description).not.toContain("**#");
    } finally {
      fake.stop();
      await repo.cleanup();
    }
  }, 30_000);

  test("maps authentication failures", async () => {
    const fake = new FakeAzureDevOps({
      organization: "example",
      project: "P",
      repository: "R",
      token: "real",
    });
    const origin = await fake.listen();
    try {
      const client = new AdoClient({
        organizationUrl: origin,
        project: "P",
        repositoryId: "app",
        authorization: `Basic ${btoa(":wrong")}`,
      });
      await expect(client.getRepository()).rejects.toThrow(/credentials/);
    } finally {
      fake.stop();
    }
  });

  test("paginates pull request lists", async () => {
    const fake = new FakeAzureDevOps({
      organization: "example",
      project: "P",
      repository: "R",
      token: "pat",
    });
    const origin = await fake.listen();
    try {
      for (let i = 0; i < 3; i++) {
        fake.pullRequests.set(200 + i, {
          pullRequestId: 200 + i,
          title: `pr-${i}`,
          status: "active",
          sourceRefName: `refs/heads/b${i}`,
          targetRefName: "refs/heads/main",
          properties: {},
        });
      }
      const client = new AdoClient({
        organizationUrl: origin,
        project: "P",
        repositoryId: "R",
        authorization: `Basic ${btoa(":pat")}`,
      });
      const listed = await client.listPullRequests({ status: "active" });
      expect(listed.length).toBe(3);
    } finally {
      fake.stop();
    }
  });

  test("submit force-with-lease after an amend", async () => {
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
      await writeCommit(repo.git, "schema.sql", "v1\n", "add schema");
      const bare = await createTempRepo({ bare: true });
      await repo.git.run(["remote", "add", "origin", bare.dir]);
      await repo.git.push("origin", "main", { setUpstream: true });
      const first = await runCli(["submit"], { cwd: repo.dir, env });
      expect(first.exitCode).toBe(0);
      await repo.git.run(["commit", "--amend", "-m", "add schema amended"]);
      const second = await runCli(["submit"], { cwd: repo.dir, env });
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain("pushed");
      await bare.cleanup();
    } finally {
      fake.stop();
      await repo.cleanup();
    }
  }, 30_000);

  test("submit from one root does not edit unrelated PRs that share trunk", async () => {
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
      for (const name of ["feat-a", "feat-b", "feat-c", "feat-d"]) {
        await repo.git.checkout("main");
        await runCli(["create", name], { cwd: repo.dir, env });
        await writeCommit(repo.git, `${name}.txt`, `${name}\n`, name);
      }
      const bare = await createTempRepo({ bare: true });
      await repo.git.run(["remote", "add", "origin", bare.dir]);
      await repo.git.push("origin", "main", { setUpstream: true });
      await repo.git.checkout("feat-c");
      const result = await runCli(["submit"], { cwd: repo.dir, env });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Submitting 1 pull request");
      expect(result.stdout).not.toContain("4-PR stack");
      expect(fake.pullRequests.size).toBe(1);
      const [pr] = [...fake.pullRequests.values()];
      expect(pr?.sourceRefName).toBe("refs/heads/feat-c");
      expect(pr?.description ?? "").not.toContain("<!-- ado-stack:start -->");
      expect(pr?.description ?? "").not.toContain("feat-a");
      await bare.cleanup();
    } finally {
      fake.stop();
      await repo.cleanup();
    }
  }, 30_000);
});
