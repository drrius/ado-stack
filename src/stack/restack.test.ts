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
});
