import { describe, expect, test } from "bun:test";
import type { AdoPullRequest } from "../../src/ado/types.ts";
import type { GitRepo } from "../../src/git/git.ts";
import { childrenOf, stackOrder } from "../../src/stack/graph.ts";
import type { StackState } from "../../src/state/schema.ts";
import { createTempRepo, runCli, writeCommit } from "../helpers/repo.ts";
import { FakeAzureDevOps } from "./fake-server.ts";

const env = { ADO_STACK_PAT: "test-pat" };

describe("forest of stacks", () => {
  test("repair adopts three children, refuses cycle and parent mismatch by name, up does not pick silently, submit is parent-before-child", async () => {
    const repo = await createTempRepo();
    const fake = new FakeAzureDevOps({
      organization: "example",
      project: "Platform",
      repository: "app",
      token: "test-pat",
    });
    try {
      const origin = await fake.listen();
      await init(repo.dir, origin);
      await seedGitForest(repo.git);

      seedPr(fake, 1981, "leaf-a", "main");
      seedPr(fake, 1994, "leaf-b", "main");
      seedPr(fake, 1995, "two-deep", "main");
      seedPr(fake, 1993, "two-deep-child", "two-deep");
      seedPr(fake, 1982, "three-parent", "main");
      seedPr(fake, 1991, "three-a", "three-parent");
      seedPr(fake, 1986, "three-b", "three-parent");
      seedPr(fake, 1989, "three-b-child", "three-b");
      seedPr(fake, 1987, "three-c", "three-parent");

      const repaired = await runCli(["repair"], { cwd: repo.dir, env });
      expect(repaired.exitCode).toBe(0);
      const state = await readState(repo.dir);
      expect(childrenOf(state, "three-parent").sort()).toEqual(["three-a", "three-b", "three-c"]);
      expect(state.branches["two-deep-child"]?.parent).toBe("two-deep");
      expect(childrenOf(state, "main")).toEqual(["leaf-a", "three-parent", "leaf-b", "two-deep"]);
      expect(state.branches["three-b"]?.lastRestackBase).toMatch(/^[0-9a-f]{40}$/);
      expect(state.branches["three-b"]?.lastRestackBase).not.toBe(
        state.branches["three-b"]?.lastLocalTip,
      );

      const status = await runCli(["status"], { cwd: repo.dir, env });
      expect(status.stdout).toContain("├──");
      expect(status.stdout).toContain("three-parent");
      expect(status.stdout).toContain("three-b-child");

      await repo.git.checkout("three-parent");
      const silentUp = await runCli(["up"], { cwd: repo.dir, env });
      expect(silentUp.exitCode).not.toBe(0);
      expect(silentUp.stderr).toContain("multiple children");
      expect(silentUp.stderr).toContain("three-a");
      expect(await repo.git.currentBranch()).toBe("three-parent");
      const namedUp = await runCli(["up", "three-b"], { cwd: repo.dir, env });
      expect(namedUp.exitCode).toBe(0);
      expect(await repo.git.currentBranch()).toBe("three-b");

      state.branches["three-a"] = {
        ...state.branches["three-a"]!,
        parent: "main",
      };
      await Bun.write(
        `${repo.dir}/.git/ado-stack/state.json`,
        `${JSON.stringify(state, null, 2)}\n`,
      );
      const beforeMismatch = await Bun.file(`${repo.dir}/.git/ado-stack/state.json`).text();
      const mismatch = await runCli(["repair"], { cwd: repo.dir, env });
      expect(mismatch.exitCode).toBe(0);
      expect(mismatch.stderr).toContain("three-a");
      expect(mismatch.stderr).toContain("disagreeing parents");
      expect(mismatch.stderr).toContain("Local state was left unchanged");
      expect(await Bun.file(`${repo.dir}/.git/ado-stack/state.json`).text()).toBe(beforeMismatch);

      fake.pullRequests.clear();
      seedPr(fake, 1, "cycle-a", "cycle-b");
      seedPr(fake, 2, "cycle-b", "cycle-a");
      const beforeCycle = await Bun.file(`${repo.dir}/.git/ado-stack/state.json`).text();
      const cycle = await runCli(["repair"], { cwd: repo.dir, env });
      expect(cycle.stderr).toContain("cycle");
      expect(cycle.stderr).toContain("cycle-a");
      expect(await Bun.file(`${repo.dir}/.git/ado-stack/state.json`).text()).toBe(beforeCycle);

      const bare = await createTempRepo({ bare: true });
      await repo.git.run(["remote", "add", "origin", bare.dir]);
      await repo.git.push("origin", "main", { setUpstream: true });
      const submit = await runCli(["submit", "--all"], { cwd: repo.dir, env });
      expect(submit.exitCode).toBe(0);
      const created = [...fake.pullRequests.values()];
      const parentBeforeChild = stackOrder(await readState(repo.dir));
      const titlesInLog = parentBeforeChild.map((branch) => {
        const index = submit.stdout.indexOf(branch);
        return { branch, index };
      });
      for (let i = 1; i < titlesInLog.length; i++) {
        expect(titlesInLog[i]!.index).toBeGreaterThan(titlesInLog[i - 1]!.index);
      }
      const childPr = created.find((pr) => pr.sourceRefName.endsWith("three-b-child"));
      expect(childPr?.targetRefName).toBe("refs/heads/three-b");
      await bare.cleanup();
    } finally {
      fake.stop();
      await repo.cleanup();
    }
  }, 60_000);

  test("init reads every active pull request past the first page and names skips", async () => {
    const repo = await createTempRepo();
    const fake = new FakeAzureDevOps({
      organization: "example",
      project: "Platform",
      repository: "app",
      token: "test-pat",
    });
    try {
      const origin = await fake.listen();
      for (let id = 1; id <= 86; id++) {
        seedPr(fake, id, `done-${id}`, "main");
        const completed = fake.pullRequests.get(id);
        if (completed) {
          completed.status = "completed";
        }
      }
      for (const [id, source] of [
        [2043, "chore/radix-vega"],
        [1994, "feat/adopted-twin"],
        ...Array.from({ length: 12 }, (_, index) => [3000 + index, `feat/page-one-${index}`]),
        [1735, "chore/source-control-telemetry-config"],
        [1866, "feat/robin-desk-booking"],
      ] as Array<[number, string]>) {
        seedPr(fake, id, source, "main");
      }
      seedPr(fake, 4099, "main", "elsewhere");

      const initialized = await runCli(
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
          "--debug",
        ],
        { cwd: repo.dir, env },
      );
      expect(initialized.exitCode).toBe(0);
      const state = await readState(repo.dir);
      expect(state.branches["chore/source-control-telemetry-config"]?.pullRequestId).toBe(1735);
      expect(state.branches["feat/robin-desk-booking"]?.pullRequestId).toBe(1866);
      expect(Object.keys(state.branches)).toHaveLength(16);
      expect(initialized.stderr).toContain("#4099");
      expect(initialized.stderr).toContain("main");
      expect(initialized.stderr).toMatch(/source branch is the default branch/i);
    } finally {
      fake.stop();
      await repo.cleanup();
    }
  }, 30_000);

  test("init applies repository default branch before reconstructing", async () => {
    const repo = await createTempRepo();
    const fake = new FakeAzureDevOps({
      organization: "example",
      project: "Platform",
      repository: "app",
      token: "test-pat",
      defaultBranch: "develop",
      repositoryId: "repo-develop",
    });
    try {
      const origin = await fake.listen();
      seedPr(fake, 501, "feature-on-develop", "develop");

      const initialized = await runCli(
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
      expect(initialized.exitCode).toBe(0);
      const state = await readState(repo.dir);
      expect(state.defaultBranch).toBe("develop");
      expect(state.repositoryId).toBe("repo-develop");
      expect(state.branches["feature-on-develop"]?.pullRequestId).toBe(501);
    } finally {
      fake.stop();
      await repo.cleanup();
    }
  }, 30_000);
});

async function init(dir: string, origin: string): Promise<void> {
  const result = await runCli(
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
    { cwd: dir, env },
  );
  expect(result.exitCode).toBe(0);
}

async function seedGitForest(git: GitRepo): Promise<void> {
  const grow = async (from: string, name: string, file: string) => {
    await git.checkout(from);
    await git.checkoutNewBranch(name);
    await writeCommit(git, file, `${name}\n`, name);
  };
  await grow("main", "leaf-a", "leaf-a.txt");
  await grow("main", "leaf-b", "leaf-b.txt");
  await grow("main", "two-deep", "two-deep.txt");
  await grow("two-deep", "two-deep-child", "two-deep-child.txt");
  await grow("main", "three-parent", "three-parent.txt");
  await grow("three-parent", "three-a", "three-a.txt");
  await grow("three-parent", "three-b", "three-b.txt");
  await grow("three-b", "three-b-child", "three-b-child.txt");
  await grow("three-parent", "three-c", "three-c.txt");
}

function seedPr(fake: FakeAzureDevOps, id: number, source: string, target: string): void {
  const pr: AdoPullRequest & { properties: Record<string, string> } = {
    pullRequestId: id,
    title: source,
    status: "active",
    sourceRefName: `refs/heads/${source}`,
    targetRefName: `refs/heads/${target}`,
    properties: {},
  };
  fake.pullRequests.set(id, pr);
}

async function readState(dir: string): Promise<StackState> {
  return (await Bun.file(`${dir}/.git/ado-stack/state.json`).json()) as StackState;
}
