// Compiles the ado-stack CLI into src-tauri/binaries as the Tauri sidecar
// (externalBin), named with the Rust target triple as Tauri requires.
//
//   bun run sidecar                 # host platform
//   bun run sidecar --triple aarch64-apple-darwin
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const TRIPLES: Record<string, string> = {
  "aarch64-apple-darwin": "bun-darwin-arm64",
  "x86_64-apple-darwin": "bun-darwin-x64",
  "x86_64-unknown-linux-gnu": "bun-linux-x64",
  "x86_64-pc-windows-msvc": "bun-windows-x64",
};

function hostTriple(): string {
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }
  if (process.platform === "win32") {
    return "x86_64-pc-windows-msvc";
  }
  return "x86_64-unknown-linux-gnu";
}

const flagIndex = process.argv.indexOf("--triple");
const triple = flagIndex === -1 ? hostTriple() : process.argv[flagIndex + 1];
if (!triple || !(triple in TRIPLES)) {
  console.error(`Unknown or missing target triple. Supported: ${Object.keys(TRIPLES).join(", ")}`);
  process.exit(1);
}
const bunTarget = TRIPLES[triple];

const repoRoot = join(import.meta.dir, "../../..");
// The CLI compiles from the repo root and needs the root dependencies, which a
// fresh clone that only ran `bun install` in apps/desktop does not have yet.
if (!(await Bun.file(join(repoRoot, "node_modules/@clack/prompts/package.json")).exists())) {
  console.log("Installing repo-root dependencies first…");
  const install = Bun.spawn(["bun", "install", "--frozen-lockfile"], {
    cwd: repoRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  const installCode = await install.exited;
  if (installCode !== 0) {
    process.exit(installCode);
  }
}
const outDir = join(import.meta.dir, "../src-tauri/binaries");
await mkdir(outDir, { recursive: true });
const suffix = triple.includes("windows") ? ".exe" : "";
const outfile = join(outDir, `ado-stack-${triple}${suffix}`);

const proc = Bun.spawn(
  [
    "bun",
    "build",
    "--compile",
    `--target=${bunTarget}`,
    "--outfile",
    outfile,
    join(repoRoot, "src/index.ts"),
  ],
  { cwd: repoRoot, stdout: "inherit", stderr: "inherit" },
);
const code = await proc.exited;
if (code !== 0) {
  process.exit(code);
}
console.log(`Sidecar ready: ${outfile}`);
