import { describe, expect, test } from "bun:test";
import type { StackState } from "../state/schema.ts";
import { formatBranch, formatStackPrChain, pullRequestWebUrl } from "./format.ts";

const state: StackState = {
  version: 1,
  organization: "https://dev.azure.com/example/",
  organizationName: "example",
  project: "Platform",
  repository: "app",
  defaultBranch: "main",
  remoteName: "origin",
  branches: {},
};

describe("CLI formatting", () => {
  test("formats display names and pull request links", () => {
    expect(formatBranch("users/alice/api", "users/alice/")).toBe("api");
    expect(pullRequestWebUrl(state, 42)).toBe(
      "https://dev.azure.com/example/Platform/_git/app/pullrequest/42",
    );
  });

  test("formats pull request chains from trunk to tip", () => {
    expect(formatStackPrChain([1, 2, 3])).toBe("#1 → #2 → #3");
  });
});
