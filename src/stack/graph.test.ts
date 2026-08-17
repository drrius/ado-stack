import { describe, expect, test } from "bun:test";
import { childOf, stackOrder } from "./graph.ts";
import { applyBranchPrefix, looksLikePrNumber, validateBranchName } from "./names.ts";
import { downBranch, upBranch } from "./navigation.ts";
import type { StackState } from "../state/schema.ts";

const state = (): StackState => ({
  version: 1,
  organization: "https://dev.azure.com/example",
  organizationName: "example",
  project: "Platform",
  repository: "app",
  defaultBranch: "main",
  remoteName: "origin",
  branches: {
    schema: {
      parent: "main",
      parentTipAtCreation: "1",
      lastRestackBase: "1",
      lastLocalTip: "2",
    },
    api: {
      parent: "schema",
      parentTipAtCreation: "2",
      lastRestackBase: "2",
      lastLocalTip: "3",
    },
    ui: {
      parent: "api",
      parentTipAtCreation: "3",
      lastRestackBase: "3",
      lastLocalTip: "4",
    },
  },
});

describe("stack graph", () => {
  test("orders a linear stack from trunk", () => {
    expect(stackOrder(state())).toEqual(["schema", "api", "ui"]);
    expect(childOf(state(), "schema")).toBe("api");
  });

  test("navigates up and down", () => {
    const s = state();
    expect(upBranch(s, "schema")).toBe("api");
    expect(downBranch(s, "ui")).toBe("api");
    expect(() => upBranch(s, "ui")).toThrow(/top of the stack/);
    expect(() => downBranch(s, "main")).toThrow(/bottom of the stack/);
  });

  test("rejects a fork", () => {
    const forked = state();
    forked.branches.other = {
      parent: "schema",
      parentTipAtCreation: "2",
      lastRestackBase: "2",
      lastLocalTip: "9",
    };
    expect(() => stackOrder(forked)).toThrow(/not linear/);
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
