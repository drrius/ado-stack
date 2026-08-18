import { describe, expect, test } from "bun:test";
import type { StackState } from "../state/schema.ts";
import { childrenOf, findCycle, missingParents, stackOrder } from "./graph.ts";
import { applyBranchPrefix, looksLikePrNumber, validateBranchName } from "./names.ts";
import { downBranch, upBranch } from "./navigation.ts";

const branch = (parent: string, pr?: number) => ({
  parent,
  parentTipAtCreation: "1",
  lastRestackBase: "1",
  lastLocalTip: "2",
  ...(pr === undefined ? {} : { pullRequestId: pr }),
});

const state = (): StackState => ({
  version: 1,
  organization: "https://dev.azure.com/example",
  organizationName: "example",
  project: "Platform",
  repository: "app",
  defaultBranch: "main",
  remoteName: "origin",
  branches: {
    schema: branch("main"),
    api: branch("schema"),
    ui: branch("api"),
  },
});

describe("stack graph", () => {
  test("orders a linear stack from trunk", () => {
    expect(stackOrder(state())).toEqual(["schema", "api", "ui"]);
    expect(childrenOf(state(), "schema")).toEqual(["api"]);
  });

  test("orders a forest depth-first, parent before child", () => {
    const forest = state();
    forest.branches = {
      "fix/a": branch("main", 1),
      "fix/b": branch("main", 2),
      base: branch("main", 3),
      child: branch("base", 4),
      grand: branch("child", 5),
      sib: branch("base", 6),
    };
    expect(stackOrder(forest)).toEqual(["fix/a", "fix/b", "base", "child", "grand", "sib"]);
    expect(childrenOf(forest, "base")).toEqual(["child", "sib"]);
  });

  test("navigates up and down a linear stack", () => {
    const s = state();
    expect(upBranch(s, "schema")).toBe("api");
    expect(downBranch(s, "ui")).toBe("api");
    expect(() => upBranch(s, "ui")).toThrow(/top of the stack/);
    expect(() => downBranch(s, "main")).toThrow(/bottom of the stack/);
  });

  test("up from a parent with several children requires a name", () => {
    const forest = state();
    forest.branches.other = branch("schema");
    expect(() => upBranch(forest, "schema")).toThrow(/multiple children/);
    expect(() => upBranch(forest, "schema")).toThrow(/other/);
    expect(upBranch(forest, "schema", "other")).toBe("other");
    expect(() => upBranch(forest, "schema", "ui")).toThrow(/not a child/);
  });

  test("finds a cycle and missing parents without treating forks as errors", () => {
    const forked = state();
    forked.branches.other = branch("schema");
    expect(stackOrder(forked)).toEqual(["schema", "api", "ui", "other"]);
    expect(findCycle(forked)).toBeUndefined();

    const cyclic = state();
    cyclic.branches.schema = branch("ui");
    cyclic.branches.api = branch("schema");
    cyclic.branches.ui = branch("api");
    expect(findCycle(cyclic)?.slice(0, 3).sort()).toEqual(["api", "schema", "ui"]);
    expect(() => stackOrder(cyclic)).toThrow(/cycle/);

    const dangling = state();
    dangling.branches.ghost = branch("missing");
    expect(missingParents(dangling)).toEqual([{ branch: "ghost", parent: "missing" }]);
    expect(() => stackOrder(dangling)).toThrow(/missing parent/);
  });
});

describe("branch naming", () => {
  test("applies a prefix once", () => {
    expect(applyBranchPrefix("schema", "darius/")).toBe("darius/schema");
    expect(applyBranchPrefix("darius/schema", "darius/")).toBe("darius/schema");
  });

  test("rejects invalid names", () => {
    expect(() => validateBranchName("has space")).toThrow(/Invalid branch name/);
    expect(() => validateBranchName("HEAD")).toThrow(/HEAD/);
  });

  test("detects PR numbers", () => {
    expect(looksLikePrNumber("143")).toBe(true);
    expect(looksLikePrNumber("api")).toBe(false);
  });
});
