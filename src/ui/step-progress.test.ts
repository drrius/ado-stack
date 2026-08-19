import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { createStepProgress } from "./step-progress.ts";

describe("step progress", () => {
  test("writes plain step lines when output is not a TTY", async () => {
    const stderr: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;

    const output = new PassThrough();
    const progress = createStepProgress({ output });
    expect(progress.interactive).toBe(false);

    const value = await progress.run("Fetch repository", async (update) => {
      update("contacting Azure DevOps");
      return 42;
    });

    process.stderr.write = originalWrite;
    expect(value).toBe(42);
    expect(stderr.join("")).toContain("Fetch repository...");
    expect(stderr.join("")).toContain("contacting Azure DevOps");
    expect(stderr.join("")).toContain("✓ Fetch repository");
  });
});
