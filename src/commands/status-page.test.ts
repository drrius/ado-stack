import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderStatusHtml, writeStatusPage } from "./status-page.ts";
import type { StatusJson } from "./status-render.ts";

const model: StatusJson = {
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
      pullRequestNumber: 10,
      pullRequestStatus: "open",
      title: "parent",
      url: "https://dev.azure.com/example/P/_git/R/pullrequest/10",
      needsRestack: false,
      diverged: false,
      ahead: 0,
      behind: 0,
      children: [
        {
          branch: "B",
          parent: "A",
          current: true,
          pullRequestNumber: 11,
          pullRequestStatus: "open",
          title: "child",
          url: "https://dev.azure.com/example/P/_git/R/pullrequest/11",
          needsRestack: true,
          diverged: false,
          ahead: 0,
          behind: 0,
          children: [],
          preflight: { kind: "conflicts", files: ["file.txt"] },
        },
      ],
      preflight: { kind: "not-needed" },
    },
  ],
};

describe("status page", () => {
  test("is one offline file with both theme palettes", () => {
    const html = renderStatusHtml(model);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain(":root");
    expect(html).toContain("--bg:");
    expect(html).toContain("@media (prefers-color-scheme: dark)");
    expect(html).toContain("body {");
    expect(html).toContain("background: var(--bg)");
    expect(html).toContain("overflow-x: hidden");
    expect(html).toContain("overflow-x: auto");
    expect(html).not.toContain("https://cdn");
    expect(html).not.toContain("fonts.googleapis");
    expect(html).toContain("file.txt");
    expect(html).toContain("pullrequest/11");
    expect(html).toContain("restacks clean");
    expect(html).toContain("function blockHeight");
    expect(html).toContain("files * FILE_ROW");
  });

  test("grows a node to fit every conflict path", () => {
    const crowded: StatusJson = {
      ...model,
      forest: [
        {
          ...model.forest[0]!,
          children: [
            {
              ...model.forest[0]!.children[0]!,
              preflight: {
                kind: "conflicts",
                files: ["a", "b", "c", "d", "e", "f", "g"],
              },
            },
          ],
        },
      ],
    };
    const html = renderStatusHtml(crowded);
    expect(html).toContain("function blockHeight");
    expect(html).toContain('"g"');
  });

  test("writeStatusPage can be opened later without ado-stack", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ado-stack-page-"));
    const dest = join(dir, "status.html");
    await writeStatusPage(dest, model);
    const html = await readFile(dest, "utf8");
    const match = html.match(/<script type="application\/json" id="model">([\s\S]*?)<\/script>/);
    expect(match?.[1]).toBeTruthy();
    const parsed = JSON.parse(match?.[1] ?? "") as StatusJson;
    expect(parsed.forest[0]?.branch).toBe("A");
    expect(parsed.forest[0]?.children[0]?.preflight).toEqual({
      kind: "conflicts",
      files: ["file.txt"],
    });
  });
});
