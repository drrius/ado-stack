import { describe, expect, test } from "bun:test";
import { flattenForest, parseStatusJson, stackPosition } from "./model.ts";

const sample = {
  defaultBranch: "main",
  currentBranch: "B",
  organization: "https://dev.azure.com/example",
  project: "P",
  repository: "R",
  forest: [
    {
      branch: "A",
      parent: "main",
      current: false,
      pullRequestNumber: 1,
      pullRequestStatus: "open",
      title: "one",
      url: "https://example/1",
      needsRestack: false,
      diverged: false,
      ahead: 0,
      behind: 0,
      children: [
        {
          branch: "B",
          parent: "A",
          current: true,
          pullRequestNumber: 2,
          pullRequestStatus: "open",
          title: "two",
          url: "https://example/2",
          needsRestack: true,
          diverged: false,
          ahead: 0,
          behind: 0,
          children: [],
          preflight: { kind: "conflicts", files: ["file.txt"] },
        },
      ],
    },
  ],
};

describe("extension status model", () => {
  test("parses the CLI forest and finds the current position", () => {
    const model = parseStatusJson(JSON.stringify(sample));
    expect(flattenForest(model.forest).map((node) => node.branch)).toEqual(["A", "B"]);
    expect(stackPosition(model)).toEqual({
      current: model.forest[0]?.children[0],
      index: 2,
      total: 2,
    });
    expect(model.forest[0]?.children[0]?.preflight).toEqual({
      kind: "conflicts",
      files: ["file.txt"],
    });
  });

  test("rejects output that is not a forest", () => {
    expect(() => parseStatusJson('{"ok":true}')).toThrow("forest");
  });
});
