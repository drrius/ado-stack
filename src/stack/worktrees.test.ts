import { describe, expect, test } from "bun:test";
import {
  formatDirtyWorktreeRefusal,
  formatHeldWorktreeRefusal,
  heldBranchesOutsideCurrent,
  planRestackWorktrees,
} from "./worktrees.ts";

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

describe("planRestackWorktrees", () => {
  test("refuses dirty foreign holds before assigning any rebase site", () => {
    const plan = planRestackWorktrees({
      currentPath: "/repo",
      worktrees: [
        { path: "/repo", branch: "main" },
        { path: "/repo-b", branch: "B" },
      ],
      branches: ["A", "B"],
      dirtyPaths: new Set(["/repo-b"]),
    });
    expect(plan).toEqual({
      kind: "refuse",
      holds: [{ branch: "B", worktreePath: "/repo-b" }],
    });
  });

  test("rebases a clean foreign hold in that worktree", () => {
    const plan = planRestackWorktrees({
      currentPath: "/repo",
      worktrees: [
        { path: "/repo", branch: "main" },
        { path: "/repo-b", branch: "B" },
      ],
      branches: ["A", "B"],
      dirtyPaths: new Set(),
    });
    expect(plan).toEqual({
      kind: "proceed",
      sites: [
        { branch: "A", path: "/repo" },
        { branch: "B", path: "/repo-b" },
      ],
    });
  });
});

describe("worktree refusal copy", () => {
  test("lists every held branch and its worktree", () => {
    const message = formatHeldWorktreeRefusal([
      { branch: "scratch/wt-b", worktreePath: "/tmp/ados-probe" },
    ]);
    expect(message).toContain("`scratch/wt-b`");
    expect(message).toContain("/tmp/ados-probe");
    expect(message).toContain("No branches were rebased or pushed.");
    expect(formatDirtyWorktreeRefusal([{ branch: "B", worktreePath: "/wt" }])).toContain(
      "uncommitted changes",
    );
  });
});
