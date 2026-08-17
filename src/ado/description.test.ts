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
    expect(block).toContain("- **#102 API**");
    expect(block).toContain("- #103 UI");
    expect(block).toContain("<!-- ado-stack:start -->");
    expect(block).toContain("<!-- ado-stack:end -->");
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
