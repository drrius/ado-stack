import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runTui } from "../../src/tui/session.ts";
import type { UpdateNotice } from "../../src/update.ts";
import { FakeAzureDevOps } from "../ado/fake-server.ts";
import { type TempRepo, createTempRepo, runCli, writeCommit } from "../helpers/repo.ts";

const KEY = { enter: "\r", up: "\x1b[A", ctrlC: "\x03" };

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*[A-Za-z]`, "g");

type Driver = {
  buffer: () => string;
  waitFor: (needle: string) => Promise<void>;
  press: (key: string) => void;
  done: Promise<number>;
};

function startSession(
  cwd: string,
  options: { checkUpdate?: (configDir: string) => Promise<UpdateNotice> } = {},
): Driver {
  const input = new PassThrough();
  const output = new PassThrough();
  let buffer = "";
  output.on("data", (chunk) => {
    buffer += chunk.toString();
  });
  const done = runTui({ cwd, io: { input, output }, ...options });
  return {
    buffer: () => buffer,
    waitFor: async (needle) => {
      const deadline = Date.now() + 10_000;
      let seen = "";
      while (Date.now() < deadline) {
        seen = buffer.replace(ANSI_PATTERN, "");
        if (seen.includes(needle)) {
          return;
        }
        await Bun.sleep(25);
      }
      throw new Error(`Timed out waiting for ${JSON.stringify(needle)} in:\n${seen}`);
    },
    press: (key) => {
      input.write(key);
    },
    done,
  };
}

describe("TUI session smoke", () => {
  const savedEnv = { ...process.env };
  let repo: TempRepo;
  let bare: TempRepo;
  let fake: FakeAzureDevOps;

  beforeAll(async () => {
    repo = await createTempRepo();
    bare = await createTempRepo({ bare: true });
    fake = new FakeAzureDevOps({
      organization: "example",
      project: "Platform",
      repository: "app",
      token: "test-pat",
    });
    const origin = await fake.listen();
    await repo.git.run(["remote", "add", "origin", bare.dir]);
    await repo.git.push("origin", "main", { setUpstream: true });
    const env = { ADO_STACK_PAT: "test-pat" };
    await runCli(
      ["init", "--organization", origin, "--project", "Platform", "--repository", "app"],
      { cwd: repo.dir, env },
    );
    await runCli(["create", "feat-a"], { cwd: repo.dir, env });
    await writeCommit(repo.git, "a.txt", "one\n", "add feature a");
    await runCli(["submit"], { cwd: repo.dir, env });
    process.env.ADO_STACK_CONFIG_DIR = join(repo.dir, ".ado-stack-home");
    process.env.ADO_STACK_AUTH_MODE = "pat";
    process.env.ADO_STACK_PAT = "test-pat";
    process.env.ADO_STACK_NO_UPDATE_CHECK = "1";
  });

  afterAll(async () => {
    process.env = { ...savedEnv };
    fake.stop();
    await repo.cleanup();
    await bare.cleanup();
  });

  test("home renders live PR status and navigation checks out a branch", async () => {
    const session = startSession(repo.dir);
    await session.waitFor("What next?");
    const home = session.buffer().replace(ANSI_PATTERN, "");
    expect(home).toContain("main (trunk)");
    expect(home).toContain("feat-a");
    expect(home).toContain("#100");
    expect(home).toContain("OPEN");
    expect(home).toContain("add feature a");
    expect(home).toContain("pullrequest/100");
    expect(home).toContain("Stack is in sync.");

    session.press(KEY.enter);
    await session.waitFor("Check out");
    session.press(KEY.up);
    session.press(KEY.enter);
    await session.waitFor("Checked out main");

    await session.waitFor("What next?");
    session.press(KEY.ctrlC);
    const code = await session.done;
    expect(code).toBe(0);
    expect(await repo.git.currentBranch()).toBe("main");
    expect(session.buffer()).not.toContain("test-pat");
  }, 30_000);

  test("startup notice offers update when a newer release exists", async () => {
    const session = startSession(repo.dir, {
      checkUpdate: async () => ({ kind: "available", current: "0.2.1", latest: "9.9.9" }),
    });
    await session.waitFor("9.9.9 is available");
    await session.waitFor("Update ado-stack");
    session.press(KEY.ctrlC);
    expect(await session.done).toBe(0);
  }, 15_000);

  test("bare non-TTY invocation falls back to the argv CLI", async () => {
    const result = await runCli([], { cwd: repo.dir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("--no-tui");
  }, 15_000);
});
