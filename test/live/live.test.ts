import { describe, expect, test } from "bun:test";

const enabled = Boolean(
  process.env.ADO_TEST_ORG &&
    process.env.ADO_TEST_PROJECT &&
    process.env.ADO_TEST_REPO &&
    process.env.ADO_TEST_PAT,
);

describe.skipIf(!enabled)("live Azure DevOps", () => {
  test("connects and lists the disposable repository", async () => {
    const { AdoClient } = await import("../../src/ado/client.ts");
    const org = process.env.ADO_TEST_ORG ?? "";
    const organizationUrl = org.startsWith("http") ? org : `https://dev.azure.com/${org}`;
    const client = new AdoClient({
      organizationUrl,
      project: process.env.ADO_TEST_PROJECT ?? "",
      repositoryId: process.env.ADO_TEST_REPO ?? "",
      authorization: `Basic ${btoa(`:${process.env.ADO_TEST_PAT}`)}`,
    });
    const repo = await client.getRepository();
    expect(repo.name.length).toBeGreaterThan(0);
  });
});
