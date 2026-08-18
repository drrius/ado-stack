import { describe, expect, test } from "bun:test";
import { createLogger } from "./log.ts";

describe("CLI logger", () => {
  test("distinguishes warnings from errors", () => {
    const stderr: string[] = [];
    const log = createLogger({
      verbose: false,
      debug: false,
      stdout: () => undefined,
      stderr: (line) => stderr.push(line),
    });

    log.warn("check authentication");
    log.error("request failed");

    expect(stderr).toEqual(["warning: check authentication", "request failed"]);
  });
});
