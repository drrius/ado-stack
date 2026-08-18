import { describe, expect, test } from "bun:test";
import { GitRepo } from "../git/git.ts";
import type { StackState } from "../state/schema.ts";
import { hydrateForestTips } from "./hydrate.ts";

const sha = (char: string): string => char.repeat(40);

describe("hydrateForestTips", () => {
  test("does not replace a recorded SHA restack base with merge-base", async () => {
    const recorded = sha("a");
    const git = new GitRepo("/tmp", async (args) => {
      if (args[0] === "show-ref") {
        const ref = args[args.length - 1];
        if (typeof ref === "string" && ref.startsWith("refs/heads/")) {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 1 };
      }
      if (args[0] === "rev-parse") {
        return { stdout: `${sha("c")}\n`, stderr: "", exitCode: 0 };
      }
      if (args[0] === "merge-base") {
        return { stdout: `${sha("b")}\n`, stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 1 };
    });
    const state: StackState = {
      version: 1,
      organization: "https://dev.azure.com/example",
      organizationName: "example",
      project: "P",
      repository: "R",
      defaultBranch: "main",
      remoteName: "origin",
      branches: {
        feat: {
          parent: "main",
          parentTipAtCreation: recorded,
          lastRestackBase: recorded,
          lastLocalTip: sha("c"),
        },
      },
    };
    await hydrateForestTips(git, state);
    expect(state.branches.feat?.lastRestackBase).toBe(recorded);
    expect(state.branches.feat?.lastLocalTip).toBe(sha("c"));
  });

  test("fills lastRestackBase from merge-base when it is still a branch name", async () => {
    const git = new GitRepo("/tmp", async (args) => {
      if (args[0] === "show-ref") {
        const ref = args[args.length - 1];
        if (typeof ref === "string" && ref.startsWith("refs/heads/")) {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 1 };
      }
      if (args[0] === "rev-parse") {
        return { stdout: `${sha("c")}\n`, stderr: "", exitCode: 0 };
      }
      if (args[0] === "merge-base") {
        return { stdout: `${sha("b")}\n`, stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 1 };
    });
    const state: StackState = {
      version: 1,
      organization: "https://dev.azure.com/example",
      organizationName: "example",
      project: "P",
      repository: "R",
      defaultBranch: "main",
      remoteName: "origin",
      branches: {
        feat: {
          parent: "main",
          parentTipAtCreation: "main",
          lastRestackBase: "main",
          lastLocalTip: "main",
        },
      },
    };
    await hydrateForestTips(git, state);
    expect(state.branches.feat?.lastRestackBase).toBe(sha("b"));
  });
});
