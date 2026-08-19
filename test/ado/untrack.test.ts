import { describe, expect, test } from "bun:test";
import type { AdoPullRequest } from "../../src/ado/types.ts";
import type { StackState } from "../../src/state/schema.ts";
import { createTempRepo, runCli, writeCommit } from "../helpers/repo.ts";
import { FakeAzureDevOps } from "./fake-server.ts";

const env = { ADO_STACK_PAT: "test-pat" };

describe("untrack survives rebuild", () => {
  test("init and repair leave an untracked branch out, then track returns it", async () => {
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
      await repo.git.checkoutNewBranch("managed");
      await writeCommit(repo.git, "managed.txt", "m\n", "managed");
      await repo.git.checkout("main");
      await repo.git.checkoutNewBranch("noise");
      await writeCommit(repo.git, "noise.txt", "n\n", "noise");
      seedPr(fake, 10, "managed", "main");
      seedPr(fake, 11, "noise", "main");

      const repaired = await runCli(["repair"], { cwd: repo.dir, env });
      expect(repaired.exitCode).toBe(0);
      expect(Object.keys((await readState(repo.dir)).branches).sort()).toEqual([
        "managed",
        "noise",
      ]);

      const untracked = await runCli(["untrack", "noise"], { cwd: repo.dir, env });
      expect(untracked.exitCode).toBe(0);
      expect((await readState(repo.dir)).untracked).toEqual(["noise"]);

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
      expect(initialized.stderr).toContain("untracked");
      expect(initialized.stderr).toContain("#11");
      expect(initialized.stdout).toContain("Skipped 1 untracked pull request");
      expect(Object.keys((await readState(repo.dir)).branches)).toEqual(["managed"]);
      expect((await readState(repo.dir)).untracked).toEqual(["noise"]);

      await repo.git.checkout("main");
      const afterInit = await runCli(["status"], { cwd: repo.dir, env });
      expect(afterInit.stdout).toContain("managed");
      expect(afterInit.stdout).not.toContain("noise");

      const listed = await runCli(["untrack", "--list"], { cwd: repo.dir, env });
      expect(listed.exitCode).toBe(0);
      expect(listed.stdout).toContain("noise");

      const repairedAgain = await runCli(["repair"], { cwd: repo.dir, env });
      expect(repairedAgain.exitCode).toBe(0);
      expect(repairedAgain.stdout).toContain("Skipped 1 untracked pull request");
      expect(Object.keys((await readState(repo.dir)).branches)).toEqual(["managed"]);

      const tracked = await runCli(["track", "noise"], { cwd: repo.dir, env });
      expect(tracked.exitCode).toBe(0);
      expect(Object.keys((await readState(repo.dir)).branches).sort()).toEqual([
        "managed",
        "noise",
      ]);
      expect((await readState(repo.dir)).untracked).toBeUndefined();
    } finally {
      fake.stop();
      await repo.cleanup();
    }
  }, 60_000);

  test("prunes an untracked name when its pull request completes", async () => {
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
      await repo.git.checkoutNewBranch("noise");
      await writeCommit(repo.git, "noise.txt", "n\n", "noise");
      seedPr(fake, 11, "noise", "main");
      expect((await runCli(["repair"], { cwd: repo.dir, env })).exitCode).toBe(0);
      expect((await runCli(["untrack", "noise"], { cwd: repo.dir, env })).exitCode).toBe(0);

      const stored = fake.pullRequests.get(11);
      if (stored) {
        stored.status = "completed";
      }
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
      expect(state.untracked).toBeUndefined();
      expect(state.branches.noise).toBeUndefined();
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
