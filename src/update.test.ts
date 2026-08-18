import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "./errors/cli-error.ts";
import {
  type HttpFetch,
  applyUpdate,
  checkForUpdate,
  compareReleaseVersions,
  formatUpdateNote,
  installHint,
  installKind,
  noticeFromVersions,
  parseReleaseVersion,
  releaseTarget,
  updateCheckDisabled,
} from "./update.ts";

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ado-stack-update-"));
  temps.push(dir);
  return dir;
}

describe("release versions", () => {
  test("parses v-prefixed and bare tags", () => {
    expect(parseReleaseVersion("v1.2.3")).toBe("1.2.3");
    expect(parseReleaseVersion("1.2.3")).toBe("1.2.3");
    expect(parseReleaseVersion("v1.2.3-beta")).toBeUndefined();
    expect(parseReleaseVersion("main")).toBeUndefined();
  });

  test("orders major.minor.patch", () => {
    expect(compareReleaseVersions("0.2.1", "0.2.1")).toBe(0);
    expect(compareReleaseVersions("0.2.2", "0.2.1")).toBe(1);
    expect(compareReleaseVersions("0.2.1", "0.3.0")).toBe(-1);
    expect(compareReleaseVersions("1.0.0", "0.9.9")).toBe(1);
  });

  test("available only when latest is newer", () => {
    expect(noticeFromVersions("0.2.1", "0.2.2")).toEqual({
      kind: "available",
      current: "0.2.1",
      latest: "0.2.2",
    });
    expect(noticeFromVersions("0.2.2", "0.2.2")).toEqual({ kind: "current", current: "0.2.2" });
    expect(noticeFromVersions("0.3.0", "0.2.2")).toEqual({ kind: "current", current: "0.3.0" });
  });
});

describe("install metadata", () => {
  test("compiled exec paths are binaries", () => {
    expect(installKind("/home/me/.local/bin/ado-stack")).toBe("binary");
    expect(installKind("C:\\\\Users\\\\me\\\\ado-stack.exe")).toBe("binary");
    expect(installKind("/usr/bin/bun")).toBe("source");
    expect(installKind("/usr/local/bin/node")).toBe("source");
  });

  test("maps release assets the installer publishes", () => {
    expect(releaseTarget("linux", "x64")?.asset).toBe("ado-stack-linux-x64");
    expect(releaseTarget("darwin", "arm64")?.asset).toBe("ado-stack-darwin-arm64");
    expect(releaseTarget("darwin", "x64")?.asset).toBe("ado-stack-darwin-x64");
    expect(releaseTarget("win32", "x64")?.asset).toBe("ado-stack-windows-x64.exe");
    expect(releaseTarget("linux", "arm64")).toBeUndefined();
  });

  test("install hint matches the published scripts", () => {
    expect(installHint("linux")).toContain("install.sh");
    expect(installHint("win32")).toContain("install.ps1");
  });

  test("note text is only for an available release", () => {
    expect(formatUpdateNote({ kind: "unknown" })).toBeUndefined();
    expect(formatUpdateNote({ kind: "current", current: "0.2.1" })).toBeUndefined();
    expect(formatUpdateNote({ kind: "available", current: "0.2.1", latest: "0.2.2" })).toBe(
      "0.2.2 is available. This install is 0.2.1.",
    );
  });

  test("ADO_STACK_NO_UPDATE_CHECK follows the TUI opt-out shape", () => {
    expect(updateCheckDisabled({})).toBe(false);
    expect(updateCheckDisabled({ ADO_STACK_NO_UPDATE_CHECK: "" })).toBe(false);
    expect(updateCheckDisabled({ ADO_STACK_NO_UPDATE_CHECK: "0" })).toBe(false);
    expect(updateCheckDisabled({ ADO_STACK_NO_UPDATE_CHECK: "1" })).toBe(true);
  });
});

describe("checkForUpdate", () => {
  test("fetches latest and caches an available notice", async () => {
    const configDir = await tempDir();
    let fetches = 0;
    const fetchImpl = fakeGithubFetch(() => {
      fetches += 1;
      return { tag: "v9.9.9" };
    });
    const first = await checkForUpdate({
      current: "0.2.1",
      configDir,
      fetch: fetchImpl,
      disabled: false,
      now: new Date("2026-08-18T00:00:00.000Z"),
    });
    const second = await checkForUpdate({
      current: "0.2.1",
      configDir,
      fetch: fetchImpl,
      disabled: false,
      now: new Date("2026-08-18T01:00:00.000Z"),
    });
    expect(first).toEqual({ kind: "available", current: "0.2.1", latest: "9.9.9" });
    expect(second).toEqual(first);
    expect(fetches).toBe(1);
  });

  test("force ignores a current cache and revalidates", async () => {
    const configDir = await tempDir();
    const tags = ["v0.2.1", "v0.2.2"];
    const fetchImpl = fakeGithubFetch(() => ({ tag: tags.shift() ?? "v0.2.2" }));
    await checkForUpdate({
      current: "0.2.1",
      configDir,
      fetch: fetchImpl,
      disabled: false,
      now: new Date("2026-08-18T00:00:00.000Z"),
    });
    const forced = await checkForUpdate({
      current: "0.2.1",
      configDir,
      fetch: fetchImpl,
      disabled: false,
      force: true,
      now: new Date("2026-08-18T00:00:01.000Z"),
    });
    expect(forced).toEqual({ kind: "available", current: "0.2.1", latest: "0.2.2" });
  });

  test("expired available cache is revalidated", async () => {
    const configDir = await tempDir();
    const tags = ["v0.2.2", "v0.2.3"];
    const fetchImpl = fakeGithubFetch(() => ({ tag: tags.shift() ?? "v0.2.3" }));
    await checkForUpdate({
      current: "0.2.1",
      configDir,
      fetch: fetchImpl,
      disabled: false,
      now: new Date("2026-08-18T00:00:00.000Z"),
    });
    const refreshed = await checkForUpdate({
      current: "0.2.1",
      configDir,
      fetch: fetchImpl,
      disabled: false,
      now: new Date("2026-08-19T01:00:00.000Z"),
    });
    expect(refreshed).toEqual({ kind: "available", current: "0.2.1", latest: "0.2.3" });
  });

  test("network failure keeps a cached available notice", async () => {
    const configDir = await tempDir();
    await checkForUpdate({
      current: "0.2.1",
      configDir,
      fetch: fakeGithubFetch(() => ({ tag: "v9.9.9" })),
      disabled: false,
      now: new Date("2026-08-18T00:00:00.000Z"),
    });
    const stale = await checkForUpdate({
      current: "0.2.1",
      configDir,
      fetch: async () => {
        throw new Error("offline");
      },
      force: true,
      now: new Date("2026-08-19T00:00:00.000Z"),
    });
    expect(stale).toEqual({ kind: "available", current: "0.2.1", latest: "9.9.9" });
  });

  test("disabled check is unknown unless forced", async () => {
    const configDir = await tempDir();
    const fetchImpl = fakeGithubFetch(() => ({ tag: "v9.9.9" }));
    const skipped = await checkForUpdate({
      current: "0.2.1",
      configDir,
      fetch: fetchImpl,
      disabled: true,
    });
    const forced = await checkForUpdate({
      current: "0.2.1",
      configDir,
      fetch: fetchImpl,
      disabled: true,
      force: true,
    });
    expect(skipped).toEqual({ kind: "unknown" });
    expect(forced).toEqual({ kind: "available", current: "0.2.1", latest: "9.9.9" });
  });
});

describe("applyUpdate", () => {
  test("replaces the dest file after checksum verification", async () => {
    const dir = await tempDir();
    const destPath = join(dir, "ado-stack");
    await writeFile(destPath, "old-binary");
    const payload = "new-binary-bytes";
    const hash = new Bun.CryptoHasher("sha256").update(payload).digest("hex");
    const result = await applyUpdate({
      destPath,
      version: "9.9.9",
      platform: "linux",
      arch: "x64",
      fetch: fakeGithubFetch(() => ({
        tag: "v9.9.9",
        files: {
          "ado-stack-linux-x64": payload,
          SHA256SUMS: `${hash}  ado-stack-linux-x64\n`,
        },
      })),
    });
    expect(result).toEqual({ latest: "9.9.9", destPath });
    expect(await readFile(destPath, "utf8")).toBe(payload);
  });

  test("moves a Windows dest aside before replacing it", async () => {
    const dir = await tempDir();
    const destPath = join(dir, "ado-stack.exe");
    await writeFile(destPath, "old-binary");
    const payload = "new-windows-bytes";
    const hash = new Bun.CryptoHasher("sha256").update(payload).digest("hex");
    await applyUpdate({
      destPath,
      version: "9.9.9",
      platform: "win32",
      arch: "x64",
      fetch: fakeGithubFetch(() => ({
        tag: "v9.9.9",
        files: {
          "ado-stack-windows-x64.exe": payload,
          SHA256SUMS: `${hash}  ado-stack-windows-x64.exe\n`,
        },
      })),
    });
    expect(await readFile(destPath, "utf8")).toBe(payload);
    expect(await readFile(`${destPath}.old`, "utf8")).toBe("old-binary");
  });

  test("replace failures name the platform install script", async () => {
    const dir = await tempDir();
    const destPath = join(dir, "ado-stack.exe");
    await writeFile(destPath, "old-binary");
    await mkdir(`${destPath}.old`);
    await writeFile(join(`${destPath}.old`, "blocker"), "held");
    const payload = "new-windows-bytes";
    const hash = new Bun.CryptoHasher("sha256").update(payload).digest("hex");
    try {
      await applyUpdate({
        destPath,
        version: "9.9.9",
        platform: "win32",
        arch: "x64",
        fetch: fakeGithubFetch(() => ({
          tag: "v9.9.9",
          files: {
            "ado-stack-windows-x64.exe": payload,
            SHA256SUMS: `${hash}  ado-stack-windows-x64.exe\n`,
          },
        })),
      });
      throw new Error("expected replace to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect(String(error)).toContain("Could not replace");
      expect((error as CliError).hint).toContain("install.ps1");
    }
  });

  test("refuses a checksum mismatch", async () => {
    const dir = await tempDir();
    const destPath = join(dir, "ado-stack");
    await writeFile(destPath, "old-binary");
    await expect(
      applyUpdate({
        destPath,
        version: "9.9.9",
        platform: "linux",
        arch: "x64",
        fetch: fakeGithubFetch(() => ({
          tag: "v9.9.9",
          files: {
            "ado-stack-linux-x64": "tampered",
            SHA256SUMS: `${"a".repeat(64)}  ado-stack-linux-x64\n`,
          },
        })),
      }),
    ).rejects.toThrow("Checksum mismatch");
    expect(await readFile(destPath, "utf8")).toBe("old-binary");
  });
});

function fakeGithubFetch(
  release: () => {
    tag: string;
    files?: Record<string, string>;
  },
): HttpFetch {
  return async (input) => {
    const url = String(input);
    const current = release();
    if (url.includes("/releases/latest") && url.includes("api.github.com")) {
      return new Response(JSON.stringify({ tag_name: current.tag }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    const name = url.split("/").pop() ?? "";
    const body = current.files?.[name];
    if (body !== undefined) {
      return new Response(body, { status: 200 });
    }
    return new Response("missing", { status: 404 });
  };
}
