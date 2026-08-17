import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

describe("force push policy", () => {
  test("source never invokes git push --force without lease", async () => {
    const glob = new Glob("src/**/*.ts");
    const hits: string[] = [];
    for await (const path of glob.scan(".")) {
      if (path.endsWith(".test.ts")) {
        continue;
      }
      const text = await Bun.file(path).text();
      if (/push\s+--force(?!-with-lease)/.test(text) || /"--force"/.test(text)) {
        hits.push(path);
      }
    }
    expect(hits).toEqual([]);
  });
});
