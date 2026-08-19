import { describe, expect, test } from "bun:test";
import type { StackState } from "../state/schema.ts";
import { reconstructForest } from "./reconstruct.ts";

const base = (): StackState => ({
  version: 1,
  organization: "https://dev.azure.com/example",
  organizationName: "example",
  project: "P",
  repository: "R",
  defaultBranch: "main",
  remoteName: "origin",
  branches: {},
});

describe("reconstructForest", () => {
  test("adopts a forest including three children of one parent", () => {
    const result = reconstructForest({
      base: base(),
      pullRequests: [
        pr(1, "leaf-a", "main"),
        pr(2, "leaf-b", "main"),
        pr(3, "base", "main"),
        pr(4, "child-a", "base"),
        pr(5, "child-b", "base"),
        pr(6, "child-c", "base"),
        pr(7, "grand", "child-b"),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.state.branches["child-a"]?.parent).toBe("base");
    expect(result.state.branches["child-b"]?.parent).toBe("base");
    expect(result.state.branches["child-c"]?.parent).toBe("base");
    expect(result.state.branches.grand?.parent).toBe("child-b");
    expect(result.state.branches["leaf-a"]?.parent).toBe("main");
    expect(Object.keys(result.state.branches)).toHaveLength(7);
  });

  test("refuses a cycle and names the branches", () => {
    const result = reconstructForest({
      base: base(),
      pullRequests: [pr(1, "A", "B"), pr(2, "B", "A")],
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.conflicts.some((conflict) => conflict.kind === "cycle")).toBe(true);
    const cycle = result.conflicts.find((conflict) => conflict.kind === "cycle");
    if (cycle?.kind === "cycle") {
      expect(cycle.branches).toContain("A");
      expect(cycle.branches).toContain("B");
    }
  });

  test("refuses a recorded parent that disagrees with the PR target", () => {
    const state = base();
    state.branches.feat = {
      parent: "main",
      parentTipAtCreation: "1",
      lastRestackBase: "1",
      lastLocalTip: "2",
    };
    const result = reconstructForest({
      base: state,
      pullRequests: [pr(8, "feat", "other")],
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.conflicts[0]).toMatchObject({
      kind: "parent-mismatch",
      branch: "feat",
      recordedParent: "main",
      prTarget: "other",
    });
    expect(result.skipped).toEqual([
      {
        pullRequestId: 8,
        sourceBranch: "feat",
        reason: "not included in the reconstructed forest",
      },
    ]);
  });

  test("refuses a property parent that disagrees with the PR target", () => {
    const result = reconstructForest({
      base: base(),
      pullRequests: [
        {
          ...pr(1, "feat", "main"),
          properties: {
            version: "1",
            stackId: "s1",
            parent: "other",
            branch: "feat",
            lastRestackBase: "abc",
          },
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.conflicts[0]).toMatchObject({
      kind: "parent-mismatch",
      branch: "feat",
      propertyParent: "other",
      prTarget: "main",
    });
  });

  test("refuses multiple stack IDs without guessing", () => {
    const result = reconstructForest({
      base: base(),
      pullRequests: [
        {
          ...pr(1, "a", "main"),
          properties: {
            version: "1",
            stackId: "one",
            parent: "main",
            branch: "a",
            lastRestackBase: "x",
          },
        },
        {
          ...pr(2, "b", "main"),
          properties: {
            version: "1",
            stackId: "two",
            parent: "main",
            branch: "b",
            lastRestackBase: "y",
          },
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.conflicts[0]).toMatchObject({ kind: "multiple-stack-ids" });
    expect(result.skipped.map((skip) => skip.pullRequestId).sort()).toEqual([1, 2]);
  });

  test("ignores stack IDs on completed PRs outside the live forest", () => {
    const result = reconstructForest({
      base: base(),
      pullRequests: [
        {
          ...pr(10, "old-stack", "main"),
          status: "completed",
          properties: {
            version: "1",
            stackId: "old",
            parent: "main",
            branch: "old-stack",
            lastRestackBase: "x",
          },
        },
        {
          ...pr(1994, "leaf-b", "main"),
          properties: {
            version: "1",
            stackId: "new",
            parent: "main",
            branch: "leaf-b",
            lastRestackBase: "y",
          },
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.state.stackId).toBe("new");
    expect(result.state.branches["leaf-b"]?.pullRequestId).toBe(1994);
    expect(result.state.branches["old-stack"]).toBeUndefined();
  });

  test("refuses two pull requests for the same source branch", () => {
    const result = reconstructForest({
      base: base(),
      pullRequests: [pr(1, "feat", "main"), pr(2, "feat", "other")],
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.conflicts[0]).toMatchObject({
      kind: "duplicate-source",
      branch: "feat",
      pullRequestIds: [1, 2],
    });
  });

  test("adopts the active PR when the same source also has a completed PR", () => {
    const result = reconstructForest({
      base: base(),
      pullRequests: [
        { ...pr(1, "base", "main"), status: "completed" },
        pr(2, "base", "main"),
        pr(3, "child", "base"),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.state.branches.base?.pullRequestId).toBe(2);
    expect(result.state.branches.child?.parent).toBe("base");
  });

  test("does not walk a completed PR parent when an active PR retargeted away", () => {
    const result = reconstructForest({
      base: base(),
      pullRequests: [
        { ...pr(1, "stale-parent", "main"), status: "completed" },
        { ...pr(2, "feat", "stale-parent"), status: "completed" },
        pr(3, "feat", "main"),
        pr(4, "leaf", "main"),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.state.branches.feat?.parent).toBe("main");
    expect(result.state.branches.feat?.pullRequestId).toBe(3);
    expect(result.state.branches["stale-parent"]).toBeUndefined();
    expect(result.state.branches.leaf?.parent).toBe("main");
  });

  test("still keeps a completed parent that an active child targets", () => {
    const result = reconstructForest({
      base: base(),
      pullRequests: [{ ...pr(1, "base", "main"), status: "completed" }, pr(2, "child", "base")],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.state.branches.base?.pullRequestId).toBe(1);
    expect(result.state.branches.child?.parent).toBe("base");
  });

  test("does not treat the source tip as lastRestackBase when properties are absent", () => {
    const result = reconstructForest({
      base: base(),
      pullRequests: [
        {
          ...pr(1, "feat", "main"),
          lastMergeSourceCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.state.branches.feat?.lastRestackBase).toBe("main");
    expect(result.state.branches.feat?.lastLocalTip).toBe(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
  });

  test("keeps a recorded lastRestackBase when the PR target agrees", () => {
    const state = base();
    state.branches.feat = {
      parent: "main",
      parentTipAtCreation: "parent-at-create",
      lastRestackBase: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      lastLocalTip: "cccccccccccccccccccccccccccccccccccccccc",
    };
    const result = reconstructForest({
      base: state,
      pullRequests: [
        {
          ...pr(1, "feat", "main"),
          lastMergeSourceCommit: "dddddddddddddddddddddddddddddddddddddddd",
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.state.branches.feat?.lastRestackBase).toBe(
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    expect(result.state.branches.feat?.parentTipAtCreation).toBe("parent-at-create");
  });

  test("names an active pull request whose source is trunk", () => {
    const result = reconstructForest({
      base: base(),
      pullRequests: [pr(1994, "leaf-b", "main"), pr(1735, "main", "other")],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.state.branches["leaf-b"]?.pullRequestId).toBe(1994);
    expect(result.skipped).toEqual([
      {
        pullRequestId: 1735,
        sourceBranch: "main",
        reason: "source branch is the default branch",
      },
    ]);
  });

  test("prefers property lastRestackBase over the recorded base", () => {
    const state = base();
    state.branches.feat = {
      parent: "main",
      parentTipAtCreation: "1",
      lastRestackBase: "recorded-base",
      lastLocalTip: "2",
    };
    const result = reconstructForest({
      base: state,
      pullRequests: [
        {
          ...pr(1, "feat", "main"),
          properties: {
            version: "1",
            stackId: "s1",
            parent: "main",
            branch: "feat",
            lastRestackBase: "property-base",
          },
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.state.branches.feat?.lastRestackBase).toBe("property-base");
  });

  test("does not adopt an untracked source and names the skip", () => {
    const state = base();
    state.untracked = ["noise"];
    const result = reconstructForest({
      base: state,
      pullRequests: [pr(1, "feat", "main"), pr(2, "noise", "main")],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(Object.keys(result.state.branches)).toEqual(["feat"]);
    expect(result.state.untracked).toEqual(["noise"]);
    expect(result.skipped).toEqual([
      {
        pullRequestId: 2,
        sourceBranch: "noise",
        reason: "untracked",
      },
    ]);
  });

  test("succeeds with an empty forest when every active PR is untracked", () => {
    const state = base();
    state.untracked = ["noise"];
    const result = reconstructForest({
      base: state,
      pullRequests: [pr(2, "noise", "main")],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.state.branches).toEqual({});
    expect(result.state.untracked).toEqual(["noise"]);
    expect(result.skipped[0]?.reason).toBe("untracked");
  });

  test("skips a child that targets an untracked parent instead of missing-parent", () => {
    const state = base();
    state.untracked = ["base"];
    const result = reconstructForest({
      base: state,
      pullRequests: [pr(1, "base", "main"), pr(2, "child", "base"), pr(3, "feat", "main")],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(Object.keys(result.state.branches).sort()).toEqual(["feat"]);
    expect(result.skipped.map((skip) => skip.sourceBranch).sort()).toEqual(["base", "child"]);
    expect(result.skipped.every((skip) => skip.reason === "untracked")).toBe(true);
  });

  test("does not carry lastKnownRemoteTip from the previous record", () => {
    const state = base();
    state.branches.feat = {
      parent: "main",
      parentTipAtCreation: "1",
      lastRestackBase: "1",
      lastLocalTip: "2",
      lastKnownRemoteTip: "stale-remote",
    };
    const result = reconstructForest({
      base: state,
      pullRequests: [pr(1, "feat", "main")],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.state.branches.feat?.lastKnownRemoteTip).toBeUndefined();
    expect(result.state.branches.feat?.lastSubmittedTip).toBe("sha-1");
  });
});

function pr(id: number, source: string, target: string) {
  return {
    id,
    status: "active" as const,
    sourceBranch: source,
    targetBranch: target,
    lastMergeSourceCommit: `sha-${id}`,
  };
}
