import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, resolveConfig } from "./schema.ts";
import { ConfigStore } from "./store.ts";

describe("config resolution", () => {
  test("parses known keys and ignores junk", () => {
    const config = parseConfig({
      version: 1,
      branchPrefix: "darius/",
      authMode: "pat",
      extra: true,
    });
    expect(config.branchPrefix).toBe("darius/");
    expect(config.authMode).toBe("pat");
  });

  test("env overrides repo and global", () => {
    const resolved = resolveConfig({
      global: { version: 1, branchPrefix: "g/" },
      repo: { version: 1, branchPrefix: "r/" },
      env: { ADO_STACK_BRANCH_PREFIX: "e/" },
    });
    expect(resolved.branchPrefix).toBe("e/");
  });

  test("round-trips repository config files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ado-stack-config-"));
    const gitDir = join(dir, ".git");
    const store = new ConfigStore(join(dir, "global"), gitDir);
    await store.writeRepo({ version: 1, branchPrefix: "x/" });
    expect((await store.readRepo()).branchPrefix).toBe("x/");
    await rm(dir, { recursive: true, force: true });
  });
});
