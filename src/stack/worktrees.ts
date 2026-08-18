import { CliError } from "../errors/cli-error.ts";
import type { GitRepo } from "../git/git.ts";
import { type GitWorktree, sameWorktreePath } from "../git/worktree.ts";

export type HeldStackBranch = {
  branch: string;
  worktreePath: string;
};

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

export function formatHeldWorktreeRefusal(holds: readonly HeldStackBranch[]): string {
  const listed = holds.map((hold) => `  \`${hold.branch}\`\n    ${hold.worktreePath}`).join("\n");
  return `Cannot restack because these branches are checked out in other Git worktrees:\n\n${listed}\n\nRestack rebases by checking out each branch. Git refuses that when another worktree already holds it.\n\nRemove those worktrees, or run restack from the worktree that holds the branch.\n\nNo branches were rebased or pushed.`;
}

export async function assertNoForeignWorktreeHolds(
  git: GitRepo,
  branches: readonly string[],
): Promise<void> {
  if (branches.length === 0) {
    return;
  }
  const holds = heldBranchesOutsideCurrent({
    currentPath: await git.toplevel(),
    worktrees: await git.listWorktrees(),
    branches,
  });
  if (holds.length === 0) {
    return;
  }
  throw new CliError(formatHeldWorktreeRefusal(holds));
}
