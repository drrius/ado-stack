import { describe, expect, test } from "bun:test";
import { parseAzureDevOpsRemote } from "../ado/remote.ts";

describe("parseAzureDevOpsRemote", () => {
  test("parses https remotes", () => {
    const parsed = parseAzureDevOpsRemote("https://dev.azure.com/example/Platform/_git/app");
    expect(parsed).toMatchObject({
      organization: "example",
      organizationUrl: "https://dev.azure.com/example",
      project: "Platform",
      repository: "app",
    });
  });

  test("parses https remotes with credentials", () => {
    const parsed = parseAzureDevOpsRemote("https://org@dev.azure.com/org/project/_git/repo");
    expect(parsed?.organization).toBe("org");
    expect(parsed?.project).toBe("project");
    expect(parsed?.repository).toBe("repo");
  });

  test("parses ssh remotes", () => {
    const parsed = parseAzureDevOpsRemote("git@ssh.dev.azure.com:v3/org/project/repo");
    expect(parsed).toMatchObject({
      organization: "org",
      project: "project",
      repository: "repo",
    });
  });

  test("parses ssh urls with scheme", () => {
    const parsed = parseAzureDevOpsRemote("ssh://git@ssh.dev.azure.com/v3/org/project/repo");
    expect(parsed?.repository).toBe("repo");
  });

  test("decodes encoded project and repository names", () => {
    const parsed = parseAzureDevOpsRemote("https://dev.azure.com/org/My%20Project/_git/my%20repo");
    expect(parsed?.project).toBe("My Project");
    expect(parsed?.repository).toBe("my repo");
  });

  test("strips .git suffix", () => {
    const parsed = parseAzureDevOpsRemote("https://dev.azure.com/org/project/_git/repo.git");
    expect(parsed?.repository).toBe("repo");
  });

  test("parses visualstudio.com https", () => {
    const parsed = parseAzureDevOpsRemote(
      "https://fabrikam.visualstudio.com/DefaultCollection/proj/_git/repo",
    );
    expect(parsed?.organization).toBe("fabrikam");
    expect(parsed?.project).toBe("proj");
  });

  test("parses vs-ssh remotes", () => {
    const parsed = parseAzureDevOpsRemote("git@vs-ssh.visualstudio.com:v3/fabrikam/proj/repo");
    expect(parsed?.organization).toBe("fabrikam");
  });

  test("returns undefined for GitHub remotes", () => {
    expect(parseAzureDevOpsRemote("https://github.com/org/repo.git")).toBeUndefined();
  });
});
