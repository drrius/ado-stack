import { describe, expect, test } from "bun:test";
import type { StackState } from "../state/schema.ts";
import { stackOrder } from "./graph.ts";
import { applyRestackStepToState } from "./restack.ts";

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
      parentTipAtCreation: "m",
      lastRestackBase: "m",
      lastLocalTip: "a2",
      pullRequestId: 1,
    },
    B: {
      parent: "A",
      parentTipAtCreation: "a2",
      lastRestackBase: "a2",
      lastLocalTip: "b2",
      pullRequestId: 2,
    },
    C: {
      parent: "B",
      parentTipAtCreation: "b2",
      lastRestackBase: "b2",
      lastLocalTip: "c1",
      pullRequestId: 3,
    },
  },
});

describe("applyRestackStepToState", () => {
  test("drops completed ancestors so the stack stays linear", () => {
    const next = applyRestackStepToState(
      state(),
      {
        branch: "B",
        onto: "main",
        ontoSha: "s",
        oldBase: "a2",
        preRebaseTip: "b2",
        retargetPrTo: "main",
        status: "done",
      },
      "b2-prime",
    );
    expect(next.branches.A).toBeUndefined();
    expect(next.branches.B?.parent).toBe("main");
    expect(next.branches.B?.lastRestackBase).toBe("s");
    expect(next.branches.C?.parent).toBe("B");
    expect(stackOrder(next)).toEqual(["B", "C"]);
  });

  test("a no-op rebase still retargets and drops completed ancestors", () => {
    const next = applyRestackStepToState(
      state(),
      {
        branch: "B",
        onto: "main",
        ontoSha: "a2",
        oldBase: "a2",
        preRebaseTip: "b2",
        retargetPrTo: "main",
        status: "pending",
      },
      "b2",
    );
    expect(next.branches.A).toBeUndefined();
    expect(next.branches.B?.parent).toBe("main");
    expect(stackOrder(next)).toEqual(["B", "C"]);
  });

  test("keeps a completed parent while other children still point at it", () => {
    const forked = state();
    forked.branches.D = {
      parent: "A",
      parentTipAtCreation: "a2",
      lastRestackBase: "a2",
      lastLocalTip: "d1",
      pullRequestId: 4,
    };
    const afterFirstChild = applyRestackStepToState(
      forked,
      {
        branch: "B",
        onto: "main",
        ontoSha: "s",
        oldBase: "a2",
        preRebaseTip: "b2",
        retargetPrTo: "main",
        status: "done",
      },
      "b2-prime",
    );
    expect(afterFirstChild.branches.A).toBeDefined();
    expect(afterFirstChild.branches.B?.parent).toBe("main");
    expect(afterFirstChild.branches.D?.parent).toBe("A");
    expect(stackOrder(afterFirstChild)).toEqual(["A", "D", "B", "C"]);

    const afterLastChild = applyRestackStepToState(
      afterFirstChild,
      {
        branch: "D",
        onto: "main",
        ontoSha: "s",
        oldBase: "a2",
        preRebaseTip: "d1",
        retargetPrTo: "main",
        status: "done",
      },
      "d1-prime",
    );
    expect(afterLastChild.branches.A).toBeUndefined();
    expect(afterLastChild.branches.D?.parent).toBe("main");
    expect(stackOrder(afterLastChild)).toEqual(["B", "C", "D"]);
  });
});
