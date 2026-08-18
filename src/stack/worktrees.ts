import { CliError } from "../errors/cli-error.ts";
import { GitRepo } from "../git/git.ts";
import { type GitWorktree, normalizeWorktreePath, sameWorktreePath } from "../git/worktree.ts";

export type HeldStackBranch = {
  branch: string;
  worktreePath: string;
};

export type RestackWorktreeSite = {
  branch: string;
  path: string;
};

export type RestackWorktreePlan =
  | { kind: "refuse"; holds: HeldStackBranch[] }
  | { kind: "proceed"; sites: RestackWorktreeSite[] };

export function heldBranchesOutsideCurrent(options: {
  currentPath: string;
  worktrees: readonly GitWorktree[];
  branches: readonly string[];
}): HeldStackBranch[] {
  return options.branches.flatMap((branch) => {
    const holder = options.worktrees.find((worktree) => worktree.branch === branch);
    if (holder === undefined || sameWorktreePath(holder.path, options.currentPath)) {
      return [];
    }
    return [{ branch, worktreePath: holder.path }];
  });
}

export function planRestackWorktrees(options: {
  currentPath: string;
  worktrees: readonly GitWorktree[];
  branches: readonly string[];
  blockedPaths: ReadonlySet<string>;
}): RestackWorktreePlan {
  const holds: HeldStackBranch[] = [];
  const sites: RestackWorktreeSite[] = [];
  for (const branch of options.branches) {
    const holder = options.worktrees.find((worktree) => worktree.branch === branch);
    if (holder === undefined || sameWorktreePath(holder.path, options.currentPath)) {
      sites.push({ branch, path: options.currentPath });
      continue;
    }
    if (options.blockedPaths.has(normalizeWorktreePath(holder.path))) {
      holds.push({ branch, worktreePath: holder.path });
      continue;
    }
    sites.push({ branch, path: holder.path });
  }
  if (holds.length > 0) {
    return { kind: "refuse", holds };
  }
  return { kind: "proceed", sites };
}

export function formatDirtyWorktreeRefusal(holds: readonly HeldStackBranch[]): string {
  const listed = holds.map((hold) => `  \`${hold.branch}\`\n    ${hold.worktreePath}`).join("\n");
  return `Cannot restack because these worktrees are not ready:\n\n${listed}\n\nCommit or stash local changes, and finish or abort any rebase in those worktrees first.\n\nNo branches were rebased or pushed.`;
}

export async function restackSitePaths(
  git: GitRepo,
  branches: readonly string[],
): Promise<string[]> {
  const currentPath = await git.toplevel();
  const worktrees = await git.listWorktrees();
  return [
    currentPath,
    ...heldBranchesOutsideCurrent({ currentPath, worktrees, branches }).map(
      (hold) => hold.worktreePath,
    ),
  ];
}

export async function firstRebaseAmong(paths: readonly string[]): Promise<GitRepo | undefined> {
  const seen = new Set<string>();
  for (const path of paths) {
    const key = normalizeWorktreePath(path);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const candidate = new GitRepo(path);
    if (await candidate.rebaseInProgress()) {
      return candidate;
    }
  }
  return undefined;
}

export async function restackRebaseGit(
  git: GitRepo,
  branches: readonly string[],
): Promise<GitRepo | undefined> {
  return firstRebaseAmong(await restackSitePaths(git, branches));
}

export async function resolveRestackWorktrees(
  git: GitRepo,
  branches: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (branches.length === 0) {
    return new Map();
  }
  const currentPath = await git.toplevel();
  const worktrees = await git.listWorktrees();
  const blockedPaths = new Set<string>();
  for (const hold of heldBranchesOutsideCurrent({ currentPath, worktrees, branches })) {
    const site = new GitRepo(hold.worktreePath);
    const status = await site.workingTreeStatus();
    if (!status.clean || (await site.rebaseInProgress())) {
      blockedPaths.add(normalizeWorktreePath(hold.worktreePath));
    }
  }
  const plan = planRestackWorktrees({
    currentPath,
    worktrees,
    branches,
    blockedPaths,
  });
  switch (plan.kind) {
    case "refuse":
      throw new CliError(formatDirtyWorktreeRefusal(plan.holds));
    case "proceed":
      return new Map(plan.sites.map((site) => [site.branch, site.path]));
    default: {
      const _exhaustive: never = plan;
      return _exhaustive;
    }
  }
}
