import { describe, expect, test } from "bun:test";
import { generateStackBlock, humanDescription, upsertManagedSection } from "./description.ts";

describe("PR managed section", () => {
  test("generates a stack block that highlights the current PR", () => {
    const block = generateStackBlock([
      { id: 101, title: "Schema", current: false },
      { id: 102, title: "API", current: true },
      { id: 103, title: "UI", current: false },
    ]);
    expect(block).toContain("- #101 Schema");
    expect(block).toContain("- #102 **API**");
    expect(block).toContain("- #103 UI");
    expect(block).not.toContain("**#");
    expect(block).toContain("<!-- ado-stack:start -->");
    expect(block).toContain("<!-- ado-stack:end -->");
  });

  test("renders a forest when parent links are present", () => {
    const block = generateStackBlock([
      { id: 1, title: "base", current: false, branch: "base", parent: "main" },
      { id: 2, title: "left", current: true, branch: "left", parent: "base" },
      { id: 3, title: "right", current: false, branch: "right", parent: "base" },
      { id: 4, title: "leaf", current: false, branch: "leaf", parent: "main" },
    ]);
    expect(block).toContain("├── #1 base");
    expect(block).toContain("#2 **left**");
    expect(block).toContain("#3 right");
    expect(block).toContain("#4 leaf");
    expect(block).not.toContain("- #1 base");
    expect(block).not.toContain("**#");
  });

  test("keeps #id outside bold so Azure DevOps still autolinks and keeps tree connectors", () => {
    const block = generateStackBlock([
      { id: 2054, title: "Add vendor seed tools", current: false, branch: "seed", parent: "main" },
      {
        id: 2125,
        title: "feat(contacts): persist phone slot deletion across HR sync",
        current: false,
        branch: "phone",
        parent: "seed",
      },
      {
        id: 2126,
        title: "Add desktop PWA install and auto semver",
        current: true,
        branch: "pwa",
        parent: "phone",
      },
      { id: 2127, title: "Rework vendor contact UI", current: false, branch: "ui", parent: "pwa" },
    ]);
    expect(block).toContain("└── #2054 Add vendor seed tools");
    expect(block).toContain("└── #2125 feat(contacts): persist phone slot deletion across HR sync");
    expect(block).toContain("└── #2126 **Add desktop PWA install and auto semver**");
    expect(block).toContain("└── #2127 Rework vendor contact UI");
    expect(block).not.toContain("**#2126");
    expect(block).not.toContain("**#");
  });

  test("preserves human description when inserting a managed block", () => {
    const next = upsertManagedSection(
      "Please review the API.\n",
      generateStackBlock([{ id: 1, title: "API", current: true }]),
    );
    expect(next.startsWith("Please review the API.")).toBe(true);
    expect(next).toContain("<!-- ado-stack:start -->");
  });

  test("replaces an existing managed block without touching human text", () => {
    const initial = upsertManagedSection(
      "Keep me\n",
      generateStackBlock([{ id: 1, title: "A", current: true }]),
    );
    const updated = upsertManagedSection(
      initial,
      generateStackBlock([
        { id: 1, title: "A", current: false },
        { id: 2, title: "B", current: true },
      ]),
    );
    expect(humanDescription(updated).trim()).toBe("Keep me");
    expect(updated).toContain("#2 B");
    expect(updated).not.toContain("- **#1 A**");
  });
});
