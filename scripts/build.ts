#!/usr/bin/env bun

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const targets = [
  { target: "bun-darwin-arm64", outfile: "ado-stack-darwin-arm64" },
  { target: "bun-darwin-x64", outfile: "ado-stack-darwin-x64" },
  { target: "bun-linux-x64", outfile: "ado-stack-linux-x64" },
  { target: "bun-windows-x64", outfile: "ado-stack-windows-x64.exe" },
] as const;

const dist = join(import.meta.dir, "..", "dist");
await mkdir(dist, { recursive: true });

const entry = join(import.meta.dir, "..", "src", "index.ts");
const built: string[] = [];

for (const item of targets) {
  const outfile = join(dist, item.outfile);
  const proc = Bun.spawn(
    ["bun", "build", "--compile", `--target=${item.target}`, "--outfile", outfile, entry],
    { stdout: "inherit", stderr: "inherit" },
  );
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`Failed to compile ${item.outfile}`);
  }
  built.push(item.outfile);
}

const sums: string[] = [];
for (const name of built) {
  const bytes = await Bun.file(join(dist, name)).arrayBuffer();
  const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  sums.push(`${hash}  ${name}`);
}
await Bun.write(join(dist, "SHA256SUMS"), `${sums.join("\n")}\n`);
console.log(`Wrote ${built.length} binaries and SHA256SUMS to dist/`);
