import { describe, expect, test } from "bun:test";
import type { StackState } from "../state/schema.ts";
import { displayWidth } from "../ui/display-width.ts";
import { type StackStatus, type StatusRow, forestLayout } from "./status-model.ts";
import {
  DEFAULT_STATUS_WIDTH,
  formatForestRows,
  parseStatusWidth,
  resolveStatusWidth,
  toStatusJson,
} from "./status-render.ts";

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

const textOptions = {
  urls: false as const,
  branchPrefix: "",
  state,
};

const parent: StatusRow = {
  branch: "fix/editor-batch-save-pending-state",
  parent: "main",
  pr: {
    kind: "loaded",
    id: 1982,
    title: "[Editor UX][WP1] fix(editor): report batch save results",
    url: "https://dev.azure.com/example/Platform/_git/app/pullrequest/1982",
    state: "open",
  },
  isCurrent: false,
  needsRestack: true,
  diverged: false,
  ahead: 0,
  behind: 0,
};

const child: StatusRow = {
  branch: "feat/editor-field-validation",
  parent: "fix/editor-batch-save-pending-state",
  pr: {
    kind: "loaded",
    id: 1986,
    title: "[Editor UX][WP3] Add client field validation",
    url: "https://dev.azure.com/example/Platform/_git/app/pullrequest/1986",
    state: "open",
  },
  isCurrent: true,
  needsRestack: false,
  diverged: false,
  ahead: 0,
  behind: 0,
};

const sibling: StatusRow = {
  branch: "docs/readme",
  parent: "main",
  pr: { kind: "none" },
  isCurrent: false,
  needsRestack: false,
  diverged: true,
  ahead: 2,
  behind: 1,
};

const status: StackStatus = {
  rows: [parent, child, sibling],
  currentBranch: child.branch,
  defaultBranch: "main",
  ado: { kind: "ready" },
  issues: [],
  next: "restack",
};

describe("status width", () => {
  test("uses an explicit width, then stdout columns, then COLUMNS, then 100", () => {
    expect(resolveStatusWidth({ explicit: 42, stdoutColumns: 80, columnsEnv: "120" })).toBe(42);
    expect(resolveStatusWidth({ stdoutColumns: 80, columnsEnv: "120" })).toBe(80);
    expect(resolveStatusWidth({ stdoutColumns: 0, columnsEnv: "120" })).toBe(120);
    expect(resolveStatusWidth({ stdoutColumns: 0, columnsEnv: "0" })).toBe(DEFAULT_STATUS_WIDTH);
    expect(resolveStatusWidth({})).toBe(DEFAULT_STATUS_WIDTH);
  });

  test("rejects a non-positive width flag", () => {
    expect(() => parseStatusWidth("0")).toThrow("--width requires a positive integer.");
    expect(() => parseStatusWidth("wide")).toThrow("--width requires a positive integer.");
    expect(parseStatusWidth("40")).toBe(40);
    expect(parseStatusWidth(undefined)).toBeUndefined();
  });
});

describe("status forest rendering", () => {
  test("renders one line per node at several widths", () => {
    const layout = forestLayout(status.rows, status.defaultBranch);
    expect(layout).toHaveLength(status.rows.length);
    for (const width of [40, 60, 80, 100, 160]) {
      const lines = formatForestRows(status, { ...textOptions, width });
      expect(lines).toHaveLength(layout.length);
      for (const [index, line] of lines.entries()) {
        expect(line.includes("\n")).toBe(false);
        expect(line).toContain(layout[index]!.prefix + layout[index]!.connector);
        expect(line).toMatch(/#1982|#1986|no-pr/);
        expect(line).toMatch(/OPEN|LOCAL/);
        expect(line).not.toContain("pullrequest");
      }
      expect(lines[0]).toContain("├──");
      expect(lines[0]).toContain("#1982");
      expect(lines[0]).toContain("↑ restack needed");
      expect(lines[1]).toContain("└──");
      expect(lines[1]).toContain("#1986");
      expect(lines[1]).toContain("✓ synced");
      expect(lines[2]).toContain("└──");
      expect(lines[2]).toContain("local/remote diverge");
    }
  });

  test("keeps glyphs and state at 40 columns and shrinks title then branch", () => {
    const lines = formatForestRows(status, { ...textOptions, width: 40 });
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line.includes("\n")).toBe(false);
      if (!line.includes("current")) {
        expect(displayWidth(line)).toBeLessThanOrEqual(40);
      }
    }
    expect(lines[0]).toContain("├──");
    expect(lines[0]).toContain("#1982");
    expect(lines[0]).toContain("OPEN");
    expect(lines[0]).toContain("↑ restack needed");
    expect(lines[0]).not.toContain("report batch save results");
    expect(lines[1]).toContain("✓ synced");
    expect(lines[1]).not.toContain("Add client field validation");
  });

  test("prints a URL only when asked", () => {
    const hidden = formatForestRows(status, { ...textOptions, width: 200 });
    const shown = formatForestRows(status, { ...textOptions, width: 200, urls: true });
    expect(hidden.join("\n")).not.toContain("pullrequest");
    expect(shown[0]).toContain(parent.pr.kind === "loaded" ? parent.pr.url : "");
    expect(shown.join("\n").split("\n")).toHaveLength(3);
  });

  test("derives a URL for unknown PRs from repository state", () => {
    const unknown: StatusRow = {
      ...sibling,
      branch: "feat/unknown-pr",
      pr: { kind: "unknown", id: 42 },
    };
    const lines = formatForestRows(
      { ...status, rows: [unknown] },
      { ...textOptions, width: 200, urls: true },
    );
    expect(lines[0]).toContain("https://dev.azure.com/example/Platform/_git/app/pullrequest/42");
    expect(toStatusJson({ ...status, rows: [unknown] }, state).forest[0]?.url).toBe(
      "https://dev.azure.com/example/Platform/_git/app/pullrequest/42",
    );
  });

  test("fits CJK titles by terminal columns", () => {
    const cjk: StatusRow = {
      ...parent,
      branch: "feat/cjk",
      pr: {
        kind: "loaded",
        id: 7,
        title: "修复编辑器批量保存结果",
        url: "https://dev.azure.com/example/Platform/_git/app/pullrequest/7",
        state: "open",
      },
    };
    const lines = formatForestRows({ ...status, rows: [cjk] }, { ...textOptions, width: 48 });
    expect(lines).toHaveLength(1);
    expect(displayWidth(lines[0]!)).toBeLessThanOrEqual(48);
    expect(lines[0]).toContain("└──");
    expect(lines[0]).toContain("OPEN");
    expect(lines[0]).toContain("…");
  });
});

describe("status json", () => {
  test("nests the same forest the renderer walks", () => {
    const json = toStatusJson(status, state);
    const layout = forestLayout(status.rows, status.defaultBranch);
    expect(json.forest).toHaveLength(2);
    expect(json.forest[0]?.branch).toBe(parent.branch);
    expect(json.forest[0]?.parent).toBe("main");
    expect(json.forest[0]?.pullRequestNumber).toBe(1982);
    expect(json.forest[0]?.pullRequestStatus).toBe("open");
    expect(json.forest[0]?.needsRestack).toBe(true);
    expect(json.forest[0]?.title).toBe(parent.pr.kind === "loaded" ? parent.pr.title : null);
    expect(json.forest[0]?.children).toHaveLength(1);
    expect(json.forest[0]?.children[0]?.branch).toBe(child.branch);
    expect(json.forest[0]?.children[0]?.current).toBe(true);
    expect(json.forest[1]?.branch).toBe(sibling.branch);
    expect(json.forest[1]?.pullRequestNumber).toBeNull();
    expect(json.forest[1]?.pullRequestStatus).toBe("none");
    expect(json.forest[1]?.diverged).toBe(true);
    expect(json.forest[1]?.ahead).toBe(2);
    expect(json.forest[1]?.behind).toBe(1);
    expect(walkJson(json.forest).map((node) => node.branch)).toEqual(
      layout.map((line) => line.row.branch),
    );
    const text = JSON.stringify(json);
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("Stack");
  });
});

function walkJson(
  nodes: ReturnType<typeof toStatusJson>["forest"],
): ReturnType<typeof toStatusJson>["forest"] {
  const out: ReturnType<typeof toStatusJson>["forest"] = [];
  const visit = (node: (typeof nodes)[number]): void => {
    out.push(node);
    for (const child of node.children) {
      visit(child);
    }
  };
  for (const node of nodes) {
    visit(node);
  }
  return out;
}
