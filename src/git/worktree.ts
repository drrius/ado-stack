import { realpathSync } from "node:fs";

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
  const resolvedLeft = resolvedWorktreePath(left);
  const resolvedRight = resolvedWorktreePath(right);
  if (resolvedLeft !== undefined && resolvedRight !== undefined) {
    return resolvedLeft === resolvedRight;
  }
  return normalizeWorktreePath(left) === normalizeWorktreePath(right);
}

export function normalizeWorktreePath(path: string): string {
  const unified = path.replaceAll("\\", "/");
  if (unified.length > 1 && unified.endsWith("/")) {
    return unified.slice(0, -1);
  }
  return unified;
}

function resolvedWorktreePath(path: string): string | undefined {
  try {
    return normalizeWorktreePath(realpathSync(path));
  } catch {
    return undefined;
  }
}
