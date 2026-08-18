import { existsSync } from "node:fs";
import { CliError } from "../errors/cli-error.ts";

export class GitError extends CliError {
  readonly args: readonly string[];
  readonly stderr: string;
  readonly stdout: string;

  constructor(options: {
    args: readonly string[];
    exitCode: number;
    stderr: string;
    stdout: string;
  }) {
    const detail =
      options.stderr.trim() || options.stdout.trim() || `git exited ${options.exitCode}`;
    super(humanGitMessage(options.args, detail), {
      exitCode: options.exitCode === 0 ? 1 : options.exitCode,
      cause: new Error(detail),
    });
    this.name = "GitError";
    this.args = options.args;
    this.stderr = options.stderr;
    this.stdout = options.stdout;
  }
}

function humanGitMessage(args: readonly string[], detail: string): string {
  const command = `git ${args.join(" ")}`;
  if (/uncommitted|local changes|would be overwritten/i.test(detail)) {
    return `Git refused to continue because the working tree has local changes.\n\n${detail}\n\nCommit, stash, or revert those changes first.`;
  }
  if (/conflict|needs merge|unmerged/i.test(detail)) {
    return `Git reported a conflict while running:\n  ${command}\n\n${detail}`;
  }
  if (/not a git repository/i.test(detail)) {
    return "This directory is not a Git repository. Run this command from a clone, or `git init` first.";
  }
  return `Git command failed:\n  ${command}\n\n${detail}`;
}

export type GitRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type WorkingTreeStatus = {
  clean: boolean;
  trackedDirty: boolean;
  untracked: boolean;
  porcelain: string;
};

export type GitCommit = {
  sha: string;
  subject: string;
};

export class GitRepo {
  constructor(
    readonly cwd: string,
    private readonly runner?: (args: readonly string[], cwd: string) => Promise<GitRunResult>,
  ) {}

  async run(
    args: readonly string[],
    options: { allowFailure?: boolean } = {},
  ): Promise<GitRunResult> {
    const result = this.runner ? await this.runner(args, this.cwd) : await spawnGit(args, this.cwd);
    if (result.exitCode !== 0 && !options.allowFailure) {
      throw new GitError({
        args,
        exitCode: result.exitCode,
        stderr: result.stderr,
        stdout: result.stdout,
      });
    }
    return result;
  }

  async text(args: readonly string[]): Promise<string> {
    const result = await this.run(args);
    return result.stdout.trim();
  }

  async gitDir(): Promise<string> {
    return this.text(["rev-parse", "--absolute-git-dir"]);
  }

  async isRepository(): Promise<boolean> {
    const result = await this.run(["rev-parse", "--is-inside-work-tree"], { allowFailure: true });
    return result.exitCode === 0 && result.stdout.trim() === "true";
  }

  async currentBranch(): Promise<string | undefined> {
    const result = await this.run(["branch", "--show-current"], { allowFailure: true });
    const name = result.stdout.trim();
    return name.length > 0 ? name : undefined;
  }

  async workingTreeStatus(): Promise<WorkingTreeStatus> {
    const porcelain = (await this.text(["status", "--porcelain=v1"])).trim();
    const lines = porcelain.length === 0 ? [] : porcelain.split("\n");
    const untracked = lines.some((line) => line.startsWith("??"));
    const trackedDirty = lines.some((line) => !line.startsWith("??"));
    return {
      clean: lines.length === 0,
      trackedDirty,
      untracked,
      porcelain,
    };
  }

  async requireCleanTrackedTree(action: string): Promise<void> {
    const status = await this.workingTreeStatus();
    if (!status.trackedDirty) {
      return;
    }
    throw new CliError(
      `Cannot ${action} with uncommitted changes.\n\n${status.porcelain}\n\nCommit or stash first. ado-stack will not discard local work.`,
    );
  }

  async getRemoteUrl(remote: string): Promise<string | undefined> {
    const result = await this.run(["remote", "get-url", remote], { allowFailure: true });
    if (result.exitCode !== 0) {
      return undefined;
    }
    return result.stdout.trim() || undefined;
  }

  async listRemotes(): Promise<string[]> {
    const text = await this.text(["remote"]);
    return text.length === 0 ? [] : text.split("\n").filter(Boolean);
  }

  async fetch(remote: string): Promise<void> {
    await this.run(["fetch", remote]);
  }

  async branchExists(name: string): Promise<boolean> {
    const result = await this.run(["show-ref", "--verify", "--quiet", `refs/heads/${name}`], {
      allowFailure: true,
    });
    return result.exitCode === 0;
  }

  async remoteBranchExists(remote: string, name: string): Promise<boolean> {
    const result = await this.run(
      ["show-ref", "--verify", "--quiet", `refs/remotes/${remote}/${name}`],
      { allowFailure: true },
    );
    return result.exitCode === 0;
  }

  async createBranch(name: string, startPoint?: string): Promise<void> {
    const args = startPoint ? ["branch", "--", name, startPoint] : ["branch", "--", name];
    await this.run(args);
  }

  async checkout(name: string): Promise<void> {
    await this.run(["checkout", name]);
  }

  async checkoutNewBranch(name: string): Promise<void> {
    await this.run(["checkout", "-b", name]);
  }

  async getBranchTip(name: string): Promise<string> {
    return this.text(["rev-parse", "--verify", `${name}^{commit}`]);
  }

  async getCommit(sha: string): Promise<GitCommit> {
    const text = await this.text(["log", "-1", "--format=%H%n%s", sha]);
    const [hash, ...subjectParts] = text.split("\n");
    if (!hash) {
      throw new CliError(`Could not read commit ${sha}.`);
    }
    return { sha: hash, subject: subjectParts.join("\n") };
  }

  async getMergeBase(a: string, b: string): Promise<string> {
    return this.text(["merge-base", a, b]);
  }

  async getCommitsBetween(fromExclusive: string, toInclusive: string): Promise<GitCommit[]> {
    const text = await this.text([
      "log",
      "--reverse",
      "--format=%H%x09%s",
      `${fromExclusive}..${toInclusive}`,
    ]);
    if (!text) {
      return [];
    }
    return text.split("\n").flatMap((line) => {
      const tab = line.indexOf("\t");
      if (tab <= 0) {
        return [];
      }
      return [{ sha: line.slice(0, tab), subject: line.slice(tab + 1) }];
    });
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const result = await this.run(["merge-base", "--is-ancestor", ancestor, descendant], {
      allowFailure: true,
    });
    return result.exitCode === 0;
  }

  async defaultRemoteHead(remote: string): Promise<string | undefined> {
    const result = await this.run(["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`], {
      allowFailure: true,
    });
    if (result.exitCode !== 0) {
      return undefined;
    }
    const ref = result.stdout.trim();
    const prefix = `refs/remotes/${remote}/`;
    return ref.startsWith(prefix) ? ref.slice(prefix.length) : undefined;
  }

  async push(
    remote: string,
    branch: string,
    options: { setUpstream?: boolean } = {},
  ): Promise<void> {
    const args = options.setUpstream ? ["push", "-u", remote, branch] : ["push", remote, branch];
    await this.run(args);
  }

  async forcePushWithLease(options: {
    remote: string;
    branch: string;
    expectedRemoteSha: string;
  }): Promise<void> {
    await this.run([
      "push",
      `--force-with-lease=${options.branch}:${options.expectedRemoteSha}`,
      options.remote,
      options.branch,
    ]);
  }

  async rebaseOnto(options: { newBase: string; oldBase: string; branch: string }): Promise<void> {
    await this.run(["rebase", "--onto", options.newBase, options.oldBase, options.branch]);
  }

  async mergeBase(a: string, b: string): Promise<string | undefined> {
    const result = await this.run(["merge-base", a, b], { allowFailure: true });
    if (result.exitCode !== 0) {
      return undefined;
    }
    const sha = result.stdout.trim();
    return sha.length > 0 ? sha : undefined;
  }

  async rebaseInProgress(): Promise<boolean> {
    const merge = await this.text(["rev-parse", "--git-path", "rebase-merge"]);
    const apply = await this.text(["rev-parse", "--git-path", "rebase-apply"]);
    return existsSync(joinPath(this.cwd, merge)) || existsSync(joinPath(this.cwd, apply));
  }

  async abortRebase(): Promise<void> {
    await this.run(["rebase", "--abort"]);
  }

  async continueRebase(): Promise<void> {
    await this.run(["-c", "core.editor=true", "rebase", "--continue"]);
  }
}

function joinPath(cwd: string, gitPath: string): string {
  if (gitPath.startsWith("/")) {
    return gitPath;
  }
  return `${cwd}/${gitPath}`;
}

async function spawnGit(args: readonly string[], cwd: string): Promise<GitRunResult> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}
