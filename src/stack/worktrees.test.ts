import { describe, expect, test } from "bun:test";
import { formatHeldWorktreeRefusal, heldBranchesOutsideCurrent } from "./worktrees.ts";

describe("heldBranchesOutsideCurrent", () => {
  test("names every foreign hold and ignores the current worktree", () => {
    expect(
      heldBranchesOutsideCurrent({
        currentPath: "/repo",
        worktrees: [
          { path: "/repo", branch: "main" },
          { path: "/repo-a", branch: "A" },
          { path: "/repo-b", branch: "B" },
        ],
        branches: ["A", "B", "C"],
      }),
    ).toEqual([
      { branch: "A", worktreePath: "/repo-a" },
      { branch: "B", worktreePath: "/repo-b" },
    ]);
  });
});

describe("formatHeldWorktreeRefusal", () => {
  test("lists every held branch and its worktree", () => {
    const message = formatHeldWorktreeRefusal([
      { branch: "scratch/wt-b", worktreePath: "/tmp/ados-probe" },
    ]);
    expect(message).toContain("`scratch/wt-b`");
    expect(message).toContain("/tmp/ados-probe");
    expect(message).toContain("No branches were rebased or pushed.");
  });
});
