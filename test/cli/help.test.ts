import { describe, expect, test } from "bun:test";
import { VERSION } from "../../src/version.ts";
import { createTempRepo, runCli } from "../helpers/repo.ts";

describe("CLI flags", () => {
  test("--help and --version work without a git repo", async () => {
    const help = await runCli(["--help"], { cwd: process.cwd() });
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("Setup:");
    expect(help.stdout).toContain("Daily:");
    expect(help.stdout).toContain("Recovery:");
    expect(help.stdout).toContain("auth login → init → create → submit");
    expect(help.stdout).toContain("update");
    const version = await runCli(["--version"], { cwd: process.cwd() });
    expect(version.exitCode).toBe(0);
    expect(version.stdout.trim()).toBe(VERSION);
  });

  test("help routes to command details", async () => {
    const help = await runCli(["help", "create"], { cwd: process.cwd() });
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("ado-stack create <name>");

    const update = await runCli(["update", "--help"], { cwd: process.cwd() });
    expect(update.exitCode).toBe(0);
    expect(update.stdout).toContain("ado-stack update");
    expect(update.stdout).toContain("GitHub Releases");

    const restack = await runCli(["restack", "--help"], { cwd: process.cwd() });
    expect(restack.exitCode).toBe(0);
    expect(restack.stdout).toContain("update its remote");
    expect(restack.stdout).toContain("never submitted");
  });

  test("rejects unknown flags and PATs on argv", async () => {
    const unknown = await runCli(["create", "--foo"], { cwd: process.cwd() });
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stderr).toContain("Unknown option `--foo`");

    const pat = await runCli(["auth", "login", "--pat", "secret"], { cwd: process.cwd() });
    expect(pat.exitCode).toBe(2);
    expect(pat.stderr).toContain("Unknown option `--pat`");

    const wrongCommand = await runCli(["status", "--continue"], { cwd: process.cwd() });
    expect(wrongCommand.exitCode).toBe(2);
    expect(wrongCommand.stderr).toContain("Unknown option `--continue`");
  });

  test("config get exits 1 when a key is unset", async () => {
    const repo = await createTempRepo();
    try {
      const result = await runCli(["config", "get", "organization"], { cwd: repo.dir });
      expect(result.exitCode).toBe(1);
    } finally {
      await repo.cleanup();
    }
  });
});
