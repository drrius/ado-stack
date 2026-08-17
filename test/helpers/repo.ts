import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitRepo } from "../../src/git/git.ts";

export type TempRepo = {
  dir: string;
  git: GitRepo;
  cleanup: () => Promise<void>;
};

export async function createTempRepo(options: { bare?: boolean } = {}): Promise<TempRepo> {
  const dir = await mkdtemp(join(tmpdir(), "ado-stack-"));
  const git = new GitRepo(dir);
  const args = options.bare
    ? ["init", "--bare", "--initial-branch=main"]
    : ["init", "--initial-branch=main"];
  await git.run(args);
  if (!options.bare) {
    await git.run(["config", "user.email", "ado-stack-test@example.com"]);
    await git.run(["config", "user.name", "ado-stack test"]);
    await git.run(["config", "commit.gpgsign", "false"]);
    await Bun.write(join(dir, "README.md"), "root\n");
    await git.run(["add", "README.md"]);
    await git.run(["commit", "-m", "initial"]);
  }
  return {
    dir,
    git,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export async function writeCommit(
  git: GitRepo,
  file: string,
  contents: string,
  message: string,
): Promise<string> {
  await Bun.write(join(git.cwd, file), contents);
  await git.run(["add", "--", file]);
  await git.run(["commit", "-m", message]);
  return git.getBranchTip("HEAD");
}

export async function runCli(
  args: string[],
  options: { cwd: string; env?: Record<string, string>; stdin?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../../src/index.ts"), ...args], {
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]).stream(),
    env: {
      ...process.env,
      ADO_STACK_CONFIG_DIR:
        options.env?.ADO_STACK_CONFIG_DIR ?? join(options.cwd, ".ado-stack-home"),
      ADO_STACK_AUTH_MODE: "pat",
      ...options.env,
    },
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}
