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
  dirtyPaths: ReadonlySet<string>;
}): RestackWorktreePlan {
  const holds: HeldStackBranch[] = [];
  const sites: RestackWorktreeSite[] = [];
  for (const branch of options.branches) {
    const holder = options.worktrees.find((worktree) => worktree.branch === branch);
    if (holder === undefined || sameWorktreePath(holder.path, options.currentPath)) {
      sites.push({ branch, path: options.currentPath });
      continue;
    }
    if (options.dirtyPaths.has(normalizeWorktreePath(holder.path))) {
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

export function formatHeldWorktreeRefusal(holds: readonly HeldStackBranch[]): string {
  const listed = holds.map((hold) => `  \`${hold.branch}\`\n    ${hold.worktreePath}`).join("\n");
  return `Cannot restack because these branches are checked out in other Git worktrees:\n\n${listed}\n\nRestack rebases by checking out each branch. Git refuses that when another worktree already holds it.\n\nRemove those worktrees, or run restack from the worktree that holds the branch.\n\nNo branches were rebased or pushed.`;
}

export function formatDirtyWorktreeRefusal(holds: readonly HeldStackBranch[]): string {
  const listed = holds.map((hold) => `  \`${hold.branch}\`\n    ${hold.worktreePath}`).join("\n");
  return `Cannot restack because these worktrees have uncommitted changes:\n\n${listed}\n\nCommit or stash in each worktree first. ado-stack will not rebase a dirty worktree, and it will not move a held branch with plumbing.\n\nNo branches were rebased or pushed.`;
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
  const dirtyPaths = new Set<string>();
  for (const hold of heldBranchesOutsideCurrent({ currentPath, worktrees, branches })) {
    const status = await new GitRepo(hold.worktreePath).workingTreeStatus();
    if (!status.clean) {
      dirtyPaths.add(normalizeWorktreePath(hold.worktreePath));
    }
  }
  const plan = planRestackWorktrees({
    currentPath,
    worktrees,
    branches,
    dirtyPaths,
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

export async function gitWithRebaseInProgress(git: GitRepo): Promise<GitRepo | undefined> {
  for (const worktree of await git.listWorktrees()) {
    const candidate = new GitRepo(worktree.path);
    if (await candidate.rebaseInProgress()) {
      return candidate;
    }
  }
  return undefined;
}
