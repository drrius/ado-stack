import { describe, expect, test } from "bun:test";
import type { StackStatus } from "../commands/status.ts";
import { renderStackLines } from "./render.ts";

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, "g");

function plain(status: StackStatus): string {
  return renderStackLines(status, "").join("\n").replace(ANSI_PATTERN, "");
}

const base: StackStatus = {
  rows: [],
  currentBranch: "main",
  defaultBranch: "main",
  ado: { kind: "ready" },
  issues: [],
  next: "create",
};

describe("renderStackLines", () => {
  test("empty stack shows trunk and coaches create", () => {
    const output = plain(base);
    expect(output).toContain("main (trunk)");
    expect(output).toContain("(empty)");
    expect(output).toContain("Next: create a stack branch");
  });

  test("unauthenticated access is called out and coaches login", () => {
    const output = plain({
      ...base,
      ado: { kind: "unavailable", reason: "unauthenticated", message: "Not authenticated." },
      next: "auth-login",
    });
    expect(output).toContain("Not authenticated to Azure DevOps. PR status is unknown.");
    expect(output).toContain("Next: log in to Azure DevOps");
  });

  test("rows show PR state, URL, and restack flag", () => {
    const output = plain({
      ...base,
      rows: [
        {
          branch: "feat-a",
          parent: "main",
          pr: {
            kind: "loaded",
            id: 101,
            title: "add a",
            url: "https://dev.azure.com/example/P/_git/R/pullrequest/101",
            state: "open",
          },
          isCurrent: true,
          needsRestack: false,
          diverged: false,
        },
        {
          branch: "feat-b",
          parent: "feat-a",
          pr: { kind: "none" },
          isCurrent: false,
          needsRestack: true,
          diverged: true,
        },
      ],
      next: "restack",
    });
    expect(output).toContain("#101");
    expect(output).toContain("OPEN");
    expect(output).toContain("add a");
    expect(output).toContain("https://dev.azure.com/example/P/_git/R/pullrequest/101");
    expect(output).toContain("✓ synced");
    expect(output).toContain("↑ restack needed");
    expect(output).toContain("local/remote diverge");
    expect(output).toContain("Next: restack onto latest parents");
  });

  test("issues render as notes", () => {
    const output = plain({ ...base, issues: ["PR #9 for feat-a could not be loaded."] });
    expect(output).toContain("note: PR #9 for feat-a could not be loaded.");
  });

  test("local-only rows coach submit instead of claiming sync", () => {
    const output = plain({
      ...base,
      rows: [
        {
          branch: "feat-a",
          parent: "main",
          pr: { kind: "none" },
          isCurrent: true,
          needsRestack: false,
          diverged: false,
        },
      ],
      next: "submit",
    });
    expect(output).toContain("Next: submit the stack");
    expect(output).not.toContain("Stack is in sync.");
  });
});
