import { describe, expect, test } from "bun:test";
import { AdoClient } from "./client.ts";
import type { AdoPullRequest } from "./types.ts";

describe("AdoClient.listPullRequests", () => {
  test("walks $skip pages when the server sends no continuation token", async () => {
    const skips: number[] = [];
    const client = new AdoClient({
      organizationUrl: "https://dev.azure.com/example",
      project: "P",
      repositoryId: "R",
      authorization: "Bearer test",
      fetch: async (input) => {
        const url = new URL(String(input));
        const skip = Number(url.searchParams.get("$skip") ?? "0");
        skips.push(skip);
        const start = skip + 1;
        const page =
          skip === 0
            ? Array.from({ length: 100 }, (_, index) => fakePr(start + index))
            : skip === 100
              ? [fakePr(101), fakePr(102)]
              : [];
        return new Response(JSON.stringify({ value: page }), {
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    const pullRequests = await client.listPullRequests({ status: "all" });
    expect(pullRequests.map((pr) => pr.pullRequestId)).toEqual(
      Array.from({ length: 102 }, (_, index) => index + 1),
    );
    expect(skips).toEqual([0, 100]);
  });
});

function fakePr(id: number): AdoPullRequest {
  return {
    pullRequestId: id,
    title: `pr-${id}`,
    status: "active",
    sourceRefName: `refs/heads/feat/${id}`,
    targetRefName: "refs/heads/main",
  };
}
