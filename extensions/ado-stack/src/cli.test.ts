import { describe, expect, test } from "bun:test";
import { classifyCliFailure } from "./cli.ts";

describe("ado-stack CLI errors", () => {
  test("names a missing state file and offers init", () => {
    const error = classifyCliFailure({
      stdout: "",
      stderr: "No ado-stack state in this repository. Run `ado-stack init` first.\n",
      exitCode: 1,
    });
    expect(error.kind).toBe("no-state");
  });

  test("says a conflicting restack left the rebase in place", () => {
    const error = classifyCliFailure({
      stdout: "",
      stderr: "Git reported a conflict while running rebase. Run ado-stack restack --continue.\n",
      exitCode: 1,
    });
    expect(error.kind).toBe("conflict");
    expect(error.message).toContain("left in place");
    expect(error.message).not.toMatch(/success/i);
  });
});
