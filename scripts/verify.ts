#!/usr/bin/env bun

import { join } from "node:path";

async function run(label: string, args: string[]): Promise<void> {
  console.log(`\n== ${label} ==`);
  const proc = Bun.spawn(args, { stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`${label} failed with exit ${code}`);
  }
}

await run("lint", ["bun", "run", "lint"]);
await run("format:check", ["bun", "run", "format:check"]);
await run("typecheck", ["bun", "run", "typecheck"]);
await run("test", ["bun", "test"]);
await run("build", ["bun", "run", "build"]);

const binaryName =
  process.platform === "linux"
    ? "ado-stack-linux-x64"
    : process.platform === "darwin"
      ? process.arch === "arm64"
        ? "ado-stack-darwin-arm64"
        : "ado-stack-darwin-x64"
      : "ado-stack-windows-x64.exe";
const binary = join(import.meta.dir, "..", "dist", binaryName);
await run("binary --help", [binary, "--help"]);
await run("binary --version", [binary, "--version"]);
