import { describe, expect, test } from "bun:test";
import { decodeStackProperties } from "../../src/ado/properties.ts";
import type { StackState } from "../../src/state/schema.ts";
import { type TempRepo, createTempRepo, runCli, writeCommit } from "../helpers/repo.ts";
import { FakeAzureDevOps } from "./fake-server.ts";

const env = { ADO_STACK_PAT: "test-pat" };

const PARENT = "fix/editor-batch-save-pending-state";
const CHILD_1986 = "feat/editor-field-validation";
const CHILD_1987 = "feat/editor-error-display";
const CHILD_1991 = "feat/editor-keyboard-nav";
const GRAND_1989 = "feat/editor-field-validation-tests";
const GRAND_1990 = "feat/editor-error-display-tests";

describe("reconcile completed merges", () => {
  test("status absorbs a no-ff merged parent with several children, then restack does not replay it", async () => {
    const repo = await createTempRepo();
    const fake = new FakeAzureDevOps({
      organization: "example",
      project: "Platform",
      repository: "app",
      token: "test-pat",
    });
    try {
      const origin = await fake.listen();
      const bare = await createTempRepo({ bare: true });
      await initWithOrigin(repo, origin, bare.dir);
      await grow(repo, "main", PARENT, "parent.ts", "parent change");
      await grow(repo, PARENT, CHILD_1986, "child-1986.ts", "child 1986");
      await grow(repo, CHILD_1986, GRAND_1989, "grand-1989.ts", "grand 1989");
      await grow(repo, PARENT, CHILD_1987, "child-1987.ts", "child 1987");
      await grow(repo, CHILD_1987, GRAND_1990, "grand-1990.ts", "grand 1990");
      await grow(repo, PARENT, CHILD_1991, "child-1991.ts", "child 1991");

      const submitted = await runCli(["submit"], { cwd: repo.dir, env });
      expect(submitted.exitCode).toBe(0);
      const parentPr = prBySource(fake, PARENT);
      const child1986 = prBySource(fake, CHILD_1986);
      const child1987 = prBySource(fake, CHILD_1987);
      const child1991 = prBySource(fake, CHILD_1991);
      const grand1989 = prBySource(fake, GRAND_1989);
      const grand1990 = prBySource(fake, GRAND_1990);
      parentPr.status = "completed";

      await mergeOnOrigin(bare.dir, PARENT, { squash: false });
      await repo.git.checkout("main");

      const status = await runCli(["status"], { cwd: repo.dir, env });
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toContain(
        `Merged PR #${parentPr.pullRequestId} \`${PARENT}\` into \`main\``,
      );
      expect(status.stdout).toContain(
        `Reparented PR #${child1986.pullRequestId} \`${CHILD_1986}\` → \`main\``,
      );
      expect(status.stdout).toContain(
        `Reparented PR #${child1987.pullRequestId} \`${CHILD_1987}\` → \`main\``,
      );
      expect(status.stdout).toContain(
        `Reparented PR #${child1991.pullRequestId} \`${CHILD_1991}\` → \`main\``,
      );
      expect(status.stdout).toContain(
        `Retargeted PR #${child1986.pullRequestId} \`${CHILD_1986}\` → \`main\``,
      );
      expect(status.stdout).toContain(
        `Retargeted PR #${child1987.pullRequestId} \`${CHILD_1987}\` → \`main\``,
      );
      expect(status.stdout).toContain(
        `Retargeted PR #${child1991.pullRequestId} \`${CHILD_1991}\` → \`main\``,
      );
      expect(status.stdout).toContain(`Deleted local branch \`${PARENT}\` (contained in \`main\`)`);

      const state = await readState(repo.dir);
      expect(state.branches[PARENT]).toBeUndefined();
      expect(state.branches[CHILD_1986]?.parent).toBe("main");
      expect(state.branches[CHILD_1987]?.parent).toBe("main");
      expect(state.branches[CHILD_1991]?.parent).toBe("main");
      expect(state.branches[GRAND_1989]?.parent).toBe(CHILD_1986);
      expect(state.branches[GRAND_1990]?.parent).toBe(CHILD_1987);
      expect(child1986.targetRefName).toBe("refs/heads/main");
      expect(child1987.targetRefName).toBe("refs/heads/main");
      expect(child1991.targetRefName).toBe("refs/heads/main");
      expect(grand1989.targetRefName).toBe(`refs/heads/${CHILD_1986}`);
      expect(grand1990.targetRefName).toBe(`refs/heads/${CHILD_1987}`);
      expect(decodeStackProperties(child1986.properties)?.parent).toBe("main");

      const restack = await runCli(["restack"], { cwd: repo.dir, env });
      expect(restack.exitCode).toBe(0);
      const mergedAt = restack.stdout.indexOf("Merged");
      const restackedAt = restack.stdout.indexOf("Restacked");
      expect(restackedAt).toBeGreaterThan(-1);
      if (mergedAt >= 0) {
        expect(mergedAt).toBeLessThan(restackedAt);
      }
      expect(restack.stdout).not.toMatch(/Restacked[\s\S]*Merged/);

      const unique1986 = await repo.git.getCommitsBetween("origin/main", CHILD_1986);
      const unique1987 = await repo.git.getCommitsBetween("origin/main", CHILD_1987);
      const unique1991 = await repo.git.getCommitsBetween("origin/main", CHILD_1991);
      expect(unique1986.map((commit) => commit.subject)).toEqual(["child 1986"]);
      expect(unique1987.map((commit) => commit.subject)).toEqual(["child 1987"]);
      expect(unique1991.map((commit) => commit.subject)).toEqual(["child 1991"]);
      for (const unique of [unique1986, unique1987, unique1991]) {
        expect(unique.map((commit) => commit.subject)).not.toContain("parent change");
      }
      await bare.cleanup();
    } finally {
      fake.stop();
      await repo.cleanup();
    }
  }, 60_000);

  test("restack prints reconcile before any Restacked line", async () => {
    const repo = await createTempRepo();
    const fake = new FakeAzureDevOps({
      organization: "example",
      project: "Platform",
      repository: "app",
      token: "test-pat",
    });
    try {
      const origin = await fake.listen();
      const bare = await createTempRepo({ bare: true });
      await initWithOrigin(repo, origin, bare.dir);
      await grow(repo, "main", PARENT, "parent.ts", "parent change");
      await grow(repo, PARENT, CHILD_1986, "child-1986.ts", "child 1986");
      const submitted = await runCli(["submit"], { cwd: repo.dir, env });
      expect(submitted.exitCode).toBe(0);
      const parentPr = prBySource(fake, PARENT);
      parentPr.status = "completed";
      await mergeOnOrigin(bare.dir, PARENT, { squash: false });
      await repo.git.checkout("main");

      const restack = await runCli(["restack"], { cwd: repo.dir, env });
      expect(restack.exitCode).toBe(0);
      const mergedAt = restack.stdout.indexOf("Merged");
      const restackedAt = restack.stdout.indexOf("Restacked");
      expect(mergedAt).toBeGreaterThan(-1);
      expect(restackedAt).toBeGreaterThan(-1);
      expect(mergedAt).toBeLessThan(restackedAt);
      expect(restack.stdout).toContain(`Merged PR #${parentPr.pullRequestId}`);
      await bare.cleanup();
    } finally {
      fake.stop();
      await repo.cleanup();
    }
  }, 30_000);

  test("a squash-merged leaf is dropped from state and the local branch is kept", async () => {
    const repo = await createTempRepo();
    const fake = new FakeAzureDevOps({
      organization: "example",
      project: "Platform",
      repository: "app",
      token: "test-pat",
    });
    try {
      const origin = await fake.listen();
      const bare = await createTempRepo({ bare: true });
      await initWithOrigin(repo, origin, bare.dir);
      await grow(repo, "main", "schema", "schema.sql", "add schema");
      const submitted = await runCli(["submit"], { cwd: repo.dir, env });
      expect(submitted.exitCode).toBe(0);
      const leaf = prBySource(fake, "schema");
      leaf.status = "completed";
      await mergeOnOrigin(bare.dir, "schema", { squash: true });
      await repo.git.checkout("main");

      const status = await runCli(["status"], { cwd: repo.dir, env });
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toContain(`Merged PR #${leaf.pullRequestId} \`schema\` into \`main\``);
      expect(status.stdout).toContain("Kept local branch `schema` (not contained in `main`)");
      const state = await readState(repo.dir);
      expect(state.branches.schema).toBeUndefined();
      expect(await repo.git.branchExists("schema")).toBe(true);
      await bare.cleanup();
    } finally {
      fake.stop();
      await repo.cleanup();
    }
  }, 30_000);

  test("a no-ff merged leaf is dropped from state and the local branch is deleted", async () => {
    const repo = await createTempRepo();
    const fake = new FakeAzureDevOps({
      organization: "example",
      project: "Platform",
      repository: "app",
      token: "test-pat",
    });
    try {
      const origin = await fake.listen();
      const bare = await createTempRepo({ bare: true });
      await initWithOrigin(repo, origin, bare.dir);
      await grow(repo, "main", "leaf", "leaf.txt", "leaf change");
      const submitted = await runCli(["submit"], { cwd: repo.dir, env });
      expect(submitted.exitCode).toBe(0);
      const leaf = prBySource(fake, "leaf");
      leaf.status = "completed";
      await mergeOnOrigin(bare.dir, "leaf", { squash: false });
      await repo.git.checkout("main");

      const status = await runCli(["status"], { cwd: repo.dir, env });
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toContain(`Merged PR #${leaf.pullRequestId} \`leaf\` into \`main\``);
      expect(status.stdout).toContain("Deleted local branch `leaf` (contained in `main`)");
      const state = await readState(repo.dir);
      expect(state.branches.leaf).toBeUndefined();
      expect(await repo.git.branchExists("leaf")).toBe(false);
      await bare.cleanup();
    } finally {
      fake.stop();
      await repo.cleanup();
    }
  }, 30_000);

  test("status skips reconcile while a restack plan is in progress", async () => {
    const repo = await createTempRepo();
    const fake = new FakeAzureDevOps({
      organization: "example",
      project: "Platform",
      repository: "app",
      token: "test-pat",
    });
    try {
      const origin = await fake.listen();
      const bare = await createTempRepo({ bare: true });
      await initWithOrigin(repo, origin, bare.dir);
      await grow(repo, "main", PARENT, "parent.ts", "parent change");
      await grow(repo, PARENT, CHILD_1986, "child-1986.ts", "child 1986");
      const submitted = await runCli(["submit"], { cwd: repo.dir, env });
      expect(submitted.exitCode).toBe(0);
      const parentPr = prBySource(fake, PARENT);
      parentPr.status = "completed";
      const before = await readState(repo.dir);
      await Bun.write(
        `${repo.dir}/.git/ado-stack/restack-in-progress.json`,
        `${JSON.stringify(
          {
            version: 1,
            steps: [
              {
                branch: CHILD_1986,
                onto: "main",
                ontoSha: before.branches[CHILD_1986]!.lastRestackBase,
                oldBase: before.branches[CHILD_1986]!.lastRestackBase,
                preRebaseTip: before.branches[CHILD_1986]!.lastLocalTip,
                status: "pending",
              },
            ],
          },
          null,
          2,
        )}\n`,
      );

      const status = await runCli(["status"], { cwd: repo.dir, env });
      expect(status.exitCode).toBe(0);
      const output = `${status.stdout}\n${status.stderr}`;
      expect(output).toContain("Skipped merge reconcile because a restack is in progress.");
      const after = await readState(repo.dir);
      expect(after.branches[PARENT]?.pullRequestId).toBe(parentPr.pullRequestId);
      expect(after.branches[CHILD_1986]?.parent).toBe(PARENT);
      await bare.cleanup();
    } finally {
      fake.stop();
      await repo.cleanup();
    }
  }, 30_000);

  test("unauthenticated status prints that merge reconcile was skipped", async () => {
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
      await runCli(["create", "A"], { cwd: repo.dir });
      const status = await runCli(["status"], { cwd: repo.dir });
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toContain(
        "Skipped merge reconcile: Not authenticated to Azure DevOps.",
      );
      expect(status.stdout).toContain("Not authenticated to Azure DevOps.");
    } finally {
      await repo.cleanup();
    }
  }, 30_000);
});

async function initWithOrigin(
  repo: TempRepo,
  organization: string,
  bareDir: string,
): Promise<void> {
  await repo.git.run(["remote", "add", "origin", bareDir]);
  await repo.git.push("origin", "main", { setUpstream: true });
  const initialized = await runCli(
    [
      "init",
      "--organization",
      organization,
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
}

async function grow(
  repo: TempRepo,
  from: string,
  name: string,
  file: string,
  message: string,
): Promise<void> {
  await repo.git.checkout(from);
  const created = await runCli(["create", name], { cwd: repo.dir, env });
  expect(created.exitCode).toBe(0);
  await writeCommit(repo.git, file, `${message}\n`, message);
}

function prBySource(fake: FakeAzureDevOps, source: string) {
  const pr = [...fake.pullRequests.values()].find((item) => item.sourceRefName.endsWith(source));
  if (!pr) {
    throw new Error(`expected PR for ${source}`);
  }
  return pr;
}

async function mergeOnOrigin(
  bareDir: string,
  branch: string,
  options: { squash: boolean },
): Promise<void> {
  const worker = `${bareDir}-merge-${options.squash ? "squash" : "noff"}`;
  expect(
    await Bun.spawn(["git", "clone", bareDir, worker], { stdout: "pipe", stderr: "pipe" }).exited,
  ).toBe(0);
  const argsList = [
    ["config", "user.email", "merge@example.com"],
    ["config", "user.name", "merge"],
    ["config", "commit.gpgsign", "false"],
    ["fetch", "origin"],
    ["checkout", branch],
    ["checkout", "main"],
    options.squash
      ? ["merge", "--squash", branch]
      : ["merge", "--no-ff", "-m", `merge ${branch}`, branch],
    ...(options.squash ? [["commit", "-m", `squash ${branch}`]] : []),
    ["push", "origin", "main"],
  ];
  for (const args of argsList) {
    expect(
      await Bun.spawn(["git", "-C", worker, ...args], { stdout: "pipe", stderr: "pipe" }).exited,
    ).toBe(0);
  }
}

async function readState(dir: string): Promise<StackState> {
  return (await Bun.file(`${dir}/.git/ado-stack/state.json`).json()) as StackState;
}
