import { describe, expect, test } from "bun:test";
import { parseWorktreePorcelain, sameWorktreePath } from "./worktree.ts";

describe("parseWorktreePorcelain", () => {
  test("maps each worktree to the branch it holds", () => {
    const worktrees = parseWorktreePorcelain(`worktree /repo
HEAD abc
branch refs/heads/main

worktree /repo-wt
HEAD def
branch refs/heads/scratch/wt-b
`);
    expect(worktrees).toEqual([
      { path: "/repo", branch: "main" },
      { path: "/repo-wt", branch: "scratch/wt-b" },
    ]);
  });

  test("omits bare worktrees and detached checkouts have no branch", () => {
    const worktrees = parseWorktreePorcelain(`worktree /repo.git
bare

worktree /repo-detached
HEAD abc
detached
`);
    expect(worktrees).toEqual([{ path: "/repo-detached" }]);
  });
});

describe("sameWorktreePath", () => {
  test("treats a trailing slash as the same worktree", () => {
    expect(sameWorktreePath("/repo", "/repo/")).toBe(true);
    expect(sameWorktreePath("/repo", "/other")).toBe(false);
  });
});
