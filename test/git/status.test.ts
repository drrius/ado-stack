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
      expect(status.stdout).toContain(
        "Skipped merge reconcile: Not authenticated to Azure DevOps.",
      );
      expect(status.stdout).toContain("Not authenticated to Azure DevOps.");
      expect(status.stdout).toContain("Next: ado-stack auth login");
      const row = status.stdout.split("\n").find((line) => line.includes("#9"));
      expect(row).toContain("UNKNOWN");
      expect(row).not.toContain("LOCAL");
    } finally {
      await repo.cleanup();
    }
  }, 30_000);

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

  test("status --json prints only the forest model on stdout", async () => {
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
      await writeCommit(repo.git, "a.txt", "one\n", "A1");
      const text = await runCli(["status", "--json", "--width", "40"], { cwd: repo.dir });
      expect(text.exitCode).toBe(0);
      expect(text.stdout).not.toContain("\u001b");
      expect(text.stdout).not.toContain("Stack");
      expect(text.stdout).not.toContain("Next:");
      expect(text.stdout.trim().startsWith("{")).toBe(true);
      const parsed = JSON.parse(text.stdout) as {
        defaultBranch: string;
        forest: Array<{
          branch: string;
          parent: string;
          pullRequestNumber: number | null;
          children: unknown[];
        }>;
      };
      expect(parsed.defaultBranch).toBe("main");
      expect(parsed.forest).toHaveLength(1);
      expect(parsed.forest[0]?.branch).toBe("A");
      expect(parsed.forest[0]?.parent).toBe("main");
      expect(parsed.forest[0]?.pullRequestNumber).toBeNull();
      expect(parsed.forest[0]?.children).toEqual([]);

      const textView = await runCli(["status", "--width", "40"], { cwd: repo.dir });
      expect(textView.exitCode).toBe(0);
      const rows = textView.stdout.split("\n").filter((line) => /├──|└──/.test(line));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toContain("└──");
      expect(rows[0]).toContain("A");
      expect(textView.stdout).not.toContain("pullrequest");
    } finally {
      await repo.cleanup();
    }
  }, 30_000);

  test("status --web writes an offline page and preflight matches merge-tree", async () => {
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

      const json = await runCli(["status", "--json", "--preflight"], { cwd: repo.dir });
      expect(json.exitCode).toBe(0);
      const parsed = JSON.parse(json.stdout) as {
        forest: Array<{
          branch: string;
          needsRestack: boolean;
          preflight?: { kind: string; files?: string[] };
          children: Array<{
            branch: string;
            needsRestack: boolean;
            preflight?: { kind: string; files?: string[] };
          }>;
        }>;
      };
      const child = parsed.forest[0]?.children[0];
      expect(child?.branch).toBe("B");
      expect(child?.needsRestack).toBe(true);
      expect(child?.preflight?.kind).toBe("conflicts");
      expect(child?.preflight?.files).toEqual(["file.txt"]);

      const parentSha = await repo.git.getBranchTip("A");
      const branchSha = await repo.git.getBranchTip("B");
      const mergeBase = await repo.git.mergeBase(parentSha, branchSha);
      expect(mergeBase).toBeTruthy();
      const tree = await repo.git.mergeTree({
        mergeBase: mergeBase!,
        ours: parentSha,
        theirs: branchSha,
      });
      expect(tree.exitCode).not.toBe(0);
      expect(tree.stdout).toContain("CONFLICT (content): Merge conflict in file.txt");

      const web = await runCli(["status", "--web"], { cwd: repo.dir });
      expect(web.exitCode).toBe(0);
      const dest = web.stdout.trim();
      expect(dest.endsWith("ado-stack/status.html")).toBe(true);
      const html = await Bun.file(dest).text();
      expect(html).toContain("file.txt");
      expect(html).toContain("conflicts in");
      expect(html).toContain(":root");
      expect(html).toContain("prefers-color-scheme: dark");
      expect(html).not.toContain("https://cdn");
    } finally {
      await repo.cleanup();
    }
  }, 30_000);
});
