export type GitWorktree = {
  path: string;
  branch?: string;
};

export function parseWorktreePorcelain(text: string): GitWorktree[] {
  const worktrees: GitWorktree[] = [];
  let path: string | undefined;
  let branch: string | undefined;
  let bare = false;

  const flush = (): void => {
    if (path !== undefined && !bare) {
      const worktree: GitWorktree = { path };
      if (branch !== undefined) {
        worktree.branch = branch;
      }
      worktrees.push(worktree);
    }
    path = undefined;
    branch = undefined;
    bare = false;
  };

  for (const line of text.split("\n")) {
    if (line.length === 0) {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      if (path !== undefined) {
        flush();
      }
      path = line.slice("worktree ".length);
      continue;
    }
    if (line === "bare") {
      bare = true;
      continue;
    }
    if (line.startsWith("branch ")) {
      branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    }
  }
  flush();
  return worktrees;
}

export function sameWorktreePath(left: string, right: string): boolean {
  return normalizeWorktreePath(left) === normalizeWorktreePath(right);
}

export function normalizeWorktreePath(path: string): string {
  if (path.length > 1 && path.endsWith("/")) {
    return path.slice(0, -1);
  }
  return path;
}
