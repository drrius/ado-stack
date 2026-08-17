import { describe, expect, test } from "bun:test";
import { runCli } from "../helpers/repo.ts";
import { VERSION } from "../../src/version.ts";

describe("CLI flags", () => {
  test("--help and --version work without a git repo", async () => {
    const help = await runCli(["--help"], { cwd: process.cwd() });
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("ado-stack");
    expect(help.stdout).toContain("submit");
    const version = await runCli(["--version"], { cwd: process.cwd() });
    expect(version.exitCode).toBe(0);
    expect(version.stdout.trim()).toBe(VERSION);
  });
});
