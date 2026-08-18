import { describe, expect, test } from "bun:test";
import { parseContentConflictPaths } from "./merge-tree.ts";

describe("parseContentConflictPaths", () => {
  test("reads CONFLICT (content) paths from merge-tree output", () => {
    const output = `1fe332c88144ae9a33f438e38a810cc5e87dce3a
100644 df967b96a579e45a18b8251732d16804b2e56a55 1	f.txt

Auto-merging f.txt
CONFLICT (content): Merge conflict in f.txt
CONFLICT (content): Merge conflict in src/app.ts
`;
    expect(parseContentConflictPaths(output)).toEqual(["f.txt", "src/app.ts"]);
  });

  test("returns no paths for a clean merge-tree", () => {
    expect(parseContentConflictPaths("abc123\n")).toEqual([]);
  });
});
