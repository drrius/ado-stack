import { describe, expect, test } from "bun:test";
import { parseArgv } from "../cli/parse.ts";
import { shouldLaunchTui } from "./mode.ts";

function launch(argv: string[], overrides: Partial<Parameters<typeof shouldLaunchTui>[0]> = {}) {
  return shouldLaunchTui({
    parsed: parseArgv(argv),
    env: {},
    stdinIsTty: true,
    stdoutIsTty: true,
    ...overrides,
  });
}

describe("shouldLaunchTui", () => {
  test("bare invocation at a TTY launches the TUI", () => {
    expect(launch([])).toBe(true);
  });

  test("explicit --help stays on the CLI", () => {
    expect(launch(["--help"])).toBe(false);
  });

  test("explicit --version stays on the CLI", () => {
    expect(launch(["--version"])).toBe(false);
  });

  test("any command stays on the CLI", () => {
    expect(launch(["status"])).toBe(false);
  });

  test("--no-tui opts out", () => {
    expect(launch(["--no-tui"])).toBe(false);
  });

  test("ADO_STACK_NO_TUI opts out unless empty or 0", () => {
    expect(launch([], { env: { ADO_STACK_NO_TUI: "1" } })).toBe(false);
    expect(launch([], { env: { ADO_STACK_NO_TUI: "true" } })).toBe(false);
    expect(launch([], { env: { ADO_STACK_NO_TUI: "0" } })).toBe(true);
    expect(launch([], { env: { ADO_STACK_NO_TUI: "" } })).toBe(true);
  });

  test("non-TTY stdin or stdout falls back to the CLI", () => {
    expect(launch([], { stdinIsTty: false })).toBe(false);
    expect(launch([], { stdoutIsTty: false })).toBe(false);
  });
});
