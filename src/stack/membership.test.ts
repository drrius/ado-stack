import { describe, expect, test } from "bun:test";
import type { StackState } from "../state/schema.ts";
import {
  excludeFromStack,
  isUntracked,
  pruneUntracked,
  releaseUntracked,
  untrackedNames,
} from "./membership.ts";

const branch = (parent: string) => ({
  parent,
  parentTipAtCreation: "1",
  lastRestackBase: "1",
  lastLocalTip: "2",
});

function state(): StackState {
  return {
    version: 1,
    organization: "https://dev.azure.com/example",
    organizationName: "example",
    project: "P",
    repository: "R",
    defaultBranch: "main",
    remoteName: "origin",
    branches: {
      kept: branch("main"),
      drop: branch("main"),
    },
  };
}

describe("membership", () => {
  test("exclude moves a name from branches to untracked", () => {
    const current = state();
    excludeFromStack(current, "drop");
    expect(current.branches.drop).toBeUndefined();
    expect(untrackedNames(current)).toEqual(["drop"]);
    expect(isUntracked(current, "drop")).toBe(true);
    expect(isUntracked(current, "kept")).toBe(false);
  });

  test("release removes a name from untracked without touching branches", () => {
    const current = state();
    excludeFromStack(current, "drop");
    releaseUntracked(current, "drop");
    expect(untrackedNames(current)).toEqual([]);
    expect(current.untracked).toBeUndefined();
    expect(current.branches.kept).toBeDefined();
  });

  test("prune drops a completed or abandoned source and keeps an active one", () => {
    const current = state();
    excludeFromStack(current, "drop");
    excludeFromStack(current, "kept");
    const pruned = pruneUntracked(current, {
      pullRequests: [
        { sourceBranch: "drop", status: "completed" },
        { sourceBranch: "kept", status: "active" },
      ],
      branchExists: () => true,
      remoteBranchExists: () => true,
    });
    expect(pruned).toEqual(["drop"]);
    expect(untrackedNames(current)).toEqual(["kept"]);
  });

  test("prune keeps an active source even when both Git refs are gone", () => {
    const current = state();
    excludeFromStack(current, "drop");
    pruneUntracked(current, {
      pullRequests: [{ sourceBranch: "drop", status: "active" }],
      branchExists: () => false,
      remoteBranchExists: () => false,
    });
    expect(untrackedNames(current)).toEqual(["drop"]);
  });

  test("prune drops a name with no PR once local and remote branches are gone", () => {
    const current = state();
    excludeFromStack(current, "drop");
    const pruned = pruneUntracked(current, {
      pullRequests: [],
      branchExists: () => false,
      remoteBranchExists: () => false,
    });
    expect(pruned).toEqual(["drop"]);
    expect(untrackedNames(current)).toEqual([]);
  });
});
