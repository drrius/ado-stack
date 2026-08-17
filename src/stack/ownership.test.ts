import { describe, expect, test } from "bun:test";
import type { StackState } from "../state/schema.ts";
import { restackNeeded } from "./ownership.ts";
import { type PullRequestSnapshot, effectiveParent } from "./restack.ts";

const state = (): StackState => ({
  version: 1,
  organization: "https://dev.azure.com/example",
  organizationName: "example",
  project: "P",
  repository: "R",
  defaultBranch: "main",
  remoteName: "origin",
  branches: {
    A: {
      parent: "main",
      parentTipAtCreation: "a0",
      lastRestackBase: "a0",
      lastLocalTip: "a1",
      pullRequestId: 1,
    },
    B: {
      parent: "A",
      parentTipAtCreation: "a1",
      lastRestackBase: "a1",
      lastLocalTip: "b1",
      pullRequestId: 2,
    },
  },
});

describe("commit-boundary restack planning", () => {
  test("restack is needed when the parent tip moved", () => {
    expect(
      restackNeeded({ lastRestackBase: "old", parentTip: "new", parentCompleted: false }),
    ).toBe(true);
    expect(
      restackNeeded({ lastRestackBase: "same", parentTip: "same", parentCompleted: false }),
    ).toBe(false);
  });

  test("completed parent walks to the next living base", () => {
    const prs = new Map<number, PullRequestSnapshot>([
      [1, { id: 1, status: "completed", sourceBranch: "A", targetBranch: "main" }],
      [2, { id: 2, status: "active", sourceBranch: "B", targetBranch: "A" }],
    ]);
    const resolved = effectiveParent({ state: state(), branch: "B", pullRequests: prs });
    expect(resolved.parent).toBe("main");
    expect(resolved.skipped).toEqual(["A"]);
    expect(resolved.parentCompleted).toBe(true);
  });

  test("abandoned parent fails closed", () => {
    const prs = new Map<number, PullRequestSnapshot>([
      [1, { id: 1, status: "abandoned", sourceBranch: "A", targetBranch: "main" }],
    ]);
    expect(() => effectiveParent({ state: state(), branch: "B", pullRequests: prs })).toThrow(
      /abandoned/,
    );
  });
});
