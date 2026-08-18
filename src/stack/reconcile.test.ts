import { describe, expect, test } from "bun:test";
import type { StackBranchState, StackState } from "../state/schema.ts";
import { stackOrder } from "./graph.ts";
import { type GitReconcileFacts, applyAbsorption, planCompletedMerges } from "./reconcile.ts";
import type { PullRequestSnapshot } from "./restack.ts";

const PARENT = "fix/editor-batch-save-pending-state";
const CHILD_1986 = "feat/editor-field-validation";
const CHILD_1987 = "feat/editor-error-display";
const CHILD_1991 = "feat/editor-keyboard-nav";
const GRAND_1989 = "feat/editor-field-validation-tests";
const GRAND_1990 = "feat/editor-error-display-tests";

function branch(
  parent: string,
  pullRequestId: number | undefined,
  lastRestackBase: string,
): StackBranchState {
  const record: StackBranchState = {
    parent,
    parentTipAtCreation: `${parent}-created`,
    lastRestackBase,
    lastLocalTip: `${lastRestackBase}-tip`,
  };
  if (pullRequestId !== undefined) {
    record.pullRequestId = pullRequestId;
  }
  return record;
}

function forestState(): StackState {
  return {
    version: 1,
    organization: "https://dev.azure.com/example",
    organizationName: "example",
    project: "P",
    repository: "R",
    defaultBranch: "main",
    remoteName: "origin",
    branches: {
      [PARENT]: branch("main", 1982, "main-tip"),
      [CHILD_1986]: branch(PARENT, 1986, "base-1986"),
      [CHILD_1987]: branch(PARENT, 1987, "base-1987"),
      [CHILD_1991]: branch(PARENT, 1991, "base-1991"),
      [GRAND_1989]: branch(CHILD_1986, 1989, "base-1989"),
      [GRAND_1990]: branch(CHILD_1987, 1990, "base-1990"),
    },
  };
}

function snapshot(
  id: number,
  status: PullRequestSnapshot["status"],
  sourceBranch: string,
  targetBranch: string,
): PullRequestSnapshot {
  return { id, status, sourceBranch, targetBranch };
}

function forestSnapshots(
  parentStatus: PullRequestSnapshot["status"] = "completed",
): Map<number, PullRequestSnapshot> {
  return new Map<number, PullRequestSnapshot>([
    [1982, snapshot(1982, parentStatus, PARENT, "main")],
    [1986, snapshot(1986, "active", CHILD_1986, PARENT)],
    [1987, snapshot(1987, "active", CHILD_1987, PARENT)],
    [1991, snapshot(1991, "active", CHILD_1991, PARENT)],
    [1989, snapshot(1989, "active", GRAND_1989, CHILD_1986)],
    [1990, snapshot(1990, "active", GRAND_1990, CHILD_1987)],
  ]);
}

function facts(
  options: {
    current?: string;
    held?: string[];
    missing?: string[];
    contained?: Array<[string, string]>;
  } = {},
): GitReconcileFacts {
  const missing = new Set(options.missing ?? []);
  const contained = new Set(
    (options.contained ?? []).map(([branch, into]) => `${branch}\n${into}`),
  );
  return {
    currentBranch: options.current,
    heldBranches: new Set(options.held ?? []),
    branchExists: (name) => !missing.has(name),
    containedIn: (name, into) => contained.has(`${name}\n${into}`),
  };
}

function applyAll(state: StackState, plan: ReturnType<typeof planCompletedMerges>): StackState {
  return plan.absorptions.reduce(
    (current, absorption) => applyAbsorption(current, absorption),
    state,
  );
}

describe("planCompletedMerges", () => {
  test("acceptance forest reparents every child and leaves grandchildren on their parents", () => {
    const state = forestState();
    const plan = planCompletedMerges({
      state,
      pullRequests: forestSnapshots(),
      facts: facts({ contained: [[PARENT, "main"]] }),
    });
    expect(plan.absorptions).toHaveLength(1);
    const absorption = plan.absorptions[0]!;
    expect(absorption.branch).toBe(PARENT);
    expect(absorption.pullRequestId).toBe(1982);
    expect(absorption.into).toBe("main");
    expect(absorption.children.map((child) => child.branch)).toEqual([
      CHILD_1986,
      CHILD_1987,
      CHILD_1991,
    ]);
    expect(absorption.children.map((child) => child.pullRequestId)).toEqual([1986, 1987, 1991]);
    expect(absorption.local).toEqual({ kind: "delete" });

    const next = applyAbsorption(state, absorption);
    expect(next.branches[PARENT]).toBeUndefined();
    expect(next.branches[CHILD_1986]?.parent).toBe("main");
    expect(next.branches[CHILD_1987]?.parent).toBe("main");
    expect(next.branches[CHILD_1991]?.parent).toBe("main");
    expect(next.branches[GRAND_1989]?.parent).toBe(CHILD_1986);
    expect(next.branches[GRAND_1990]?.parent).toBe(CHILD_1987);
    expect(stackOrder(next)).toEqual([CHILD_1986, GRAND_1989, CHILD_1987, GRAND_1990, CHILD_1991]);
  });

  test("lists every direct child on the one absorption, not just the first", () => {
    const plan = planCompletedMerges({
      state: forestState(),
      pullRequests: forestSnapshots(),
      facts: facts(),
    });
    expect(plan.absorptions[0]?.children).toHaveLength(3);
    expect(plan.absorptions[0]?.children.map((child) => child.pullRequestId)).toEqual([
      1986, 1987, 1991,
    ]);
  });

  test("a completed leaf with no children is dropped", () => {
    const state: StackState = {
      ...forestState(),
      branches: {
        leaf: branch("main", 10, "leaf-base"),
      },
    };
    const plan = planCompletedMerges({
      state,
      pullRequests: new Map([[10, snapshot(10, "completed", "leaf", "main")]]),
      facts: facts({ contained: [["leaf", "main"]] }),
    });
    expect(plan.absorptions).toEqual([
      {
        branch: "leaf",
        pullRequestId: 10,
        into: "main",
        children: [],
        local: { kind: "delete" },
      },
    ]);
    const next = applyAbsorption(state, plan.absorptions[0]!);
    expect(next.branches.leaf).toBeUndefined();
    expect(stackOrder(next)).toEqual([]);
  });

  test("a completed child in a chain is a second absorption and moves the grandchild to the living base", () => {
    const state: StackState = {
      ...forestState(),
      branches: {
        A: branch("main", 1, "a-base"),
        B: branch("A", 2, "b-base"),
        C: branch("B", 3, "c-base"),
      },
    };
    const pullRequests = new Map<number, PullRequestSnapshot>([
      [1, snapshot(1, "completed", "A", "main")],
      [2, snapshot(2, "completed", "B", "A")],
      [3, snapshot(3, "active", "C", "B")],
    ]);
    const plan = planCompletedMerges({
      state,
      pullRequests,
      facts: facts({
        contained: [
          ["A", "main"],
          ["B", "main"],
        ],
      }),
    });
    expect(plan.absorptions.map((item) => item.branch)).toEqual(["A", "B"]);
    expect(plan.absorptions[0]?.children.map((child) => child.branch)).toEqual(["B"]);
    expect(plan.absorptions[1]?.into).toBe("main");
    expect(plan.absorptions[1]?.children.map((child) => child.branch)).toEqual(["C"]);

    const next = applyAll(state, plan);
    expect(next.branches.A).toBeUndefined();
    expect(next.branches.B).toBeUndefined();
    expect(next.branches.C?.parent).toBe("main");
    expect(next.branches.C?.lastRestackBase).toBe("c-base");
  });

  test("an abandoned parent is not a merge", () => {
    const plan = planCompletedMerges({
      state: forestState(),
      pullRequests: forestSnapshots("abandoned"),
      facts: facts({ contained: [[PARENT, "main"]] }),
    });
    expect(plan.absorptions).toEqual([]);
  });

  test("a missing snapshot is not a merge", () => {
    const pullRequests = forestSnapshots();
    pullRequests.delete(1982);
    const plan = planCompletedMerges({
      state: forestState(),
      pullRequests,
      facts: facts({ contained: [[PARENT, "main"]] }),
    });
    expect(plan.absorptions).toEqual([]);
  });

  test("active and notSet snapshots are not merges", () => {
    expect(
      planCompletedMerges({
        state: forestState(),
        pullRequests: forestSnapshots("active"),
        facts: facts({ contained: [[PARENT, "main"]] }),
      }).absorptions,
    ).toEqual([]);
    expect(
      planCompletedMerges({
        state: forestState(),
        pullRequests: forestSnapshots("notSet"),
        facts: facts({ contained: [[PARENT, "main"]] }),
      }).absorptions,
    ).toEqual([]);
  });

  test("a second plan on the repaired forest is empty", () => {
    const state = forestState();
    const pullRequests = forestSnapshots();
    const first = planCompletedMerges({
      state,
      pullRequests,
      facts: facts({ contained: [[PARENT, "main"]] }),
    });
    const repaired = applyAll(state, first);
    const second = planCompletedMerges({
      state: repaired,
      pullRequests,
      facts: facts({ contained: [[PARENT, "main"]] }),
    });
    expect(second.absorptions).toEqual([]);
  });

  test("local.delete only when the branch exists, is free, and is contained", () => {
    const state = forestState();
    const pullRequests = forestSnapshots();
    expect(
      planCompletedMerges({
        state,
        pullRequests,
        facts: facts({ contained: [[PARENT, "main"]] }),
      }).absorptions[0]?.local,
    ).toEqual({ kind: "delete" });
    expect(
      planCompletedMerges({
        state,
        pullRequests,
        facts: facts(),
      }).absorptions[0]?.local,
    ).toEqual({ kind: "keep", reason: "not-contained" });
    expect(
      planCompletedMerges({
        state,
        pullRequests,
        facts: facts({ missing: [PARENT], contained: [[PARENT, "main"]] }),
      }).absorptions[0]?.local,
    ).toEqual({ kind: "keep", reason: "missing" });
    expect(
      planCompletedMerges({
        state,
        pullRequests,
        facts: facts({ current: PARENT, contained: [[PARENT, "main"]] }),
      }).absorptions[0]?.local,
    ).toEqual({ kind: "keep", reason: "checked-out" });
    expect(
      planCompletedMerges({
        state,
        pullRequests,
        facts: facts({ held: [PARENT], contained: [[PARENT, "main"]] }),
      }).absorptions[0]?.local,
    ).toEqual({ kind: "keep", reason: "held-by-worktree" });
  });

  test("applyAbsorption does not change children's lastRestackBase", () => {
    const state = forestState();
    const plan = planCompletedMerges({
      state,
      pullRequests: forestSnapshots(),
      facts: facts({ contained: [[PARENT, "main"]] }),
    });
    const next = applyAbsorption(state, plan.absorptions[0]!);
    expect(next.branches[CHILD_1986]?.lastRestackBase).toBe("base-1986");
    expect(next.branches[CHILD_1987]?.lastRestackBase).toBe("base-1987");
    expect(next.branches[CHILD_1991]?.lastRestackBase).toBe("base-1991");
    expect(next.branches[GRAND_1989]?.lastRestackBase).toBe("base-1989");
    expect(next.branches[GRAND_1990]?.lastRestackBase).toBe("base-1990");
  });
});
