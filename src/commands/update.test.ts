import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "../errors/cli-error.ts";
import type { Logger } from "../ui/log.ts";
import type { HttpFetch } from "../update.ts";
import { VERSION } from "../version.ts";
import { updateCommand } from "./update.ts";

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("updateCommand", () => {
  test("from source names the install script instead of overwriting bun", async () => {
    const configDir = await tempDir();
    const lines: string[] = [];
    try {
      await updateCommand(
        { configDir, log: captureLog(lines) },
        {
          kind: "source",
          fetch: jsonFetch({ tag_name: "v9.9.9" }),
        },
      );
      throw new Error("expected source installs to refuse self-update");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect(String(error)).toContain("running from source");
      expect(String(error)).toContain("9.9.9");
      expect((error as CliError).hint).toContain("install.sh");
    }
    expect(lines).toEqual([]);
  });

  test("replaces a release binary when a newer tag exists", async () => {
    const dir = await tempDir();
    const destPath = join(dir, "ado-stack");
    await writeFile(destPath, "old");
    const payload = "updated-binary";
    const hash = new Bun.CryptoHasher("sha256").update(payload).digest("hex");
    const lines: string[] = [];
    await updateCommand(
      { configDir: dir, log: captureLog(lines) },
      {
        kind: "binary",
        destPath,
        platform: "linux",
        arch: "x64",
        fetch: releaseFetch({
          tag: "v9.9.9",
          files: {
            "ado-stack-linux-x64": payload,
            SHA256SUMS: `${hash}  ado-stack-linux-x64\n`,
          },
        }),
      },
    );
    expect(await readFile(destPath, "utf8")).toBe(payload);
    expect(lines.some((line) => line.includes("Updated") && line.includes("9.9.9"))).toBe(true);
  });

  test("already-current source installs exit cleanly", async () => {
    const lines: string[] = [];
    await updateCommand(
      { configDir: await tempDir(), log: captureLog(lines) },
      {
        kind: "source",
        fetch: jsonFetch({ tag_name: `v${VERSION}` }),
      },
    );
    expect(lines.join("\n")).toContain(`Already on ${VERSION} (from source).`);
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ado-stack-update-cmd-"));
  temps.push(dir);
  return dir;
}

function captureLog(lines: string[]): Logger {
  const push = (message: string) => {
    lines.push(message);
  };
  return {
    error: push,
    warn: push,
    info: push,
    success: push,
    verbose: () => undefined,
    debug: () => undefined,
  };
}

function jsonFetch(body: unknown): HttpFetch {
  return async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
}

function releaseFetch(release: { tag: string; files: Record<string, string> }): HttpFetch {
  return async (input) => {
    const url = String(input);
    if (url.includes("api.github.com")) {
      return new Response(JSON.stringify({ tag_name: release.tag }), { status: 200 });
    }
    const name = url.split("/").pop() ?? "";
    const file = release.files[name];
    if (file === undefined) {
      return new Response("missing", { status: 404 });
    }
    return new Response(file, { status: 200 });
  };
}
