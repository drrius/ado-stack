import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

describe("held branch policy", () => {
  test("source never moves a branch with update-ref", async () => {
    const glob = new Glob("src/**/*.ts");
    const hits: string[] = [];
    for await (const path of glob.scan(".")) {
      if (path.endsWith(".test.ts")) {
        continue;
      }
      const text = await Bun.file(path).text();
      if (/update-ref/.test(text)) {
        hits.push(path);
      }
    }
    expect(hits).toEqual([]);
  });
});
