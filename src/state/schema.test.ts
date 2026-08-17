import { describe, expect, test } from "bun:test";
import { migrateState, parseStackState, STATE_VERSION } from "./schema.ts";

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
});
