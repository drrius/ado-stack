import { describe, expect, test } from "bun:test";
import { STATE_VERSION, migrateState, parseStackState } from "./schema.ts";

describe("stack state serialization", () => {
  const valid = {
    version: 1 as const,
    organization: "https://dev.azure.com/example",
    organizationName: "example",
    project: "Platform",
    repository: "app",
    defaultBranch: "main",
    remoteName: "origin",
    branches: {
      "user/schema": {
        parent: "main",
        parentTipAtCreation: "aaa",
        lastRestackBase: "aaa",
        lastLocalTip: "bbb",
        pullRequestId: 101,
      },
    },
  };

  test("parses version 1 state", () => {
    const parsed = parseStackState(valid);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.state.branches["user/schema"]?.pullRequestId).toBe(101);
    }
  });

  test("rejects unknown versions", () => {
    const parsed = migrateState({ ...valid, version: 99 });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain(String(STATE_VERSION));
    }
  });

  test("rejects branches missing commit boundaries", () => {
    const parsed = parseStackState({
      ...valid,
      branches: { api: { parent: "main" } },
    });
    expect(parsed.ok).toBe(false);
  });

  test("defaults a missing untracked list to empty", () => {
    const parsed = parseStackState(valid);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.state.untracked).toBeUndefined();
    }
  });

  test("parses an untracked list disjoint from branches", () => {
    const parsed = parseStackState({
      ...valid,
      untracked: ["chore/other", "feat/noise"],
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.state.untracked).toEqual(["chore/other", "feat/noise"]);
    }
  });

  test("rejects a name that is both tracked and untracked", () => {
    const parsed = parseStackState({
      ...valid,
      untracked: ["user/schema"],
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain("user/schema");
      expect(parsed.error).toContain("tracked and untracked");
    }
  });

  test("rejects a malformed untracked list", () => {
    expect(parseStackState({ ...valid, untracked: "feat" }).ok).toBe(false);
    expect(parseStackState({ ...valid, untracked: [""] }).ok).toBe(false);
    expect(parseStackState({ ...valid, untracked: ["a", "a"] }).ok).toBe(false);
  });
});
