import { describe, expect, test } from "bun:test";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { createTempRepo } from "../../test/helpers/repo.ts";
import { GitError } from "./git.ts";

describe("GitError", () => {
  test("includes hook stdout when git also writes a stderr summary", () => {
    const error = new GitError({
      args: [
        "push",
        "--force-with-lease=feat/vendor-contact-ux:a37b2166",
        "origin",
        "feat/vendor-contact-ux",
      ],
      exitCode: 1,
      stdout: "lefthook: pre-push\nprettier: .agents/skills/ado-stack/SKILL.md\n",
      stderr: "error: failed to push some refs to 'ssh.dev.azure.com:v3/org/project/repo'\n",
    });
    expect(error.message).toContain("lefthook: pre-push");
    expect(error.message).toContain("prettier: .agents/skills/ado-stack/SKILL.md");
    expect(error.message).toContain("error: failed to push some refs");
  });

  test("push failure surfaces pre-push hook stdout", async () => {
    const repo = await createTempRepo();
    const bare = await createTempRepo({ bare: true });
    try {
      await repo.git.run(["checkout", "-b", "feat/hook"]);
      await repo.git.run(["remote", "add", "origin", bare.dir]);
      const hook = join(repo.dir, ".git", "hooks", "pre-push");
      await Bun.write(
        hook,
        `#!/bin/sh
echo "lefthook: pre-push"
echo "prettier: .agents/skills/ado-stack/SKILL.md"
exit 1
`,
      );
      await chmod(hook, 0o755);
      await expect(repo.git.push("origin", "feat/hook", { setUpstream: true })).rejects.toThrow(
        /lefthook: pre-push[\s\S]*prettier: \.agents\/skills\/ado-stack\/SKILL\.md/,
      );
    } finally {
      await bare.cleanup();
      await repo.cleanup();
    }
  });
});
