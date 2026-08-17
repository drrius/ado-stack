import type { AdoPullRequest, AdoRepository, PullRequestStatus } from "../../src/ado/types.ts";

type StoredPr = AdoPullRequest & { properties: Record<string, string> };

export type FakeAdoOptions = {
  organization: string;
  project: string;
  repository: string;
  repositoryId?: string;
  defaultBranch?: string;
  token?: string;
};

export class FakeAzureDevOps {
  readonly repository: AdoRepository;
  readonly pullRequests = new Map<number, StoredPr>();
  nextId = 100;
  unauthorized = false;
  failTarget?: string;
  private server?: ReturnType<typeof Bun.serve>;

  constructor(private readonly options: FakeAdoOptions) {
    this.repository = {
      id: options.repositoryId ?? "repo-id-1",
      name: options.repository,
      defaultBranch: `refs/heads/${options.defaultBranch ?? "main"}`,
      project: { name: options.project, id: "proj-1" },
    };
  }

  get origin(): string {
    const url = this.server?.url;
    if (!url) {
      throw new Error("Fake Azure DevOps is not listening.");
    }
    return `${url.origin}/${this.options.organization}`;
  }

  async listen(): Promise<string> {
    const fake = this;
    this.server = Bun.serve({
      port: 0,
      async fetch(request) {
        return fake.handle(request);
      },
    });
    return this.origin;
  }

  stop(): void {
    this.server?.stop(true);
  }

  private async handle(request: Request): Promise<Response> {
    if (this.unauthorized) {
      return json({ message: "Access Denied" }, 401);
    }
    const expected = this.options.token;
    if (expected) {
      const header = request.headers.get("authorization") ?? "";
      const ok = header === `Basic ${btoa(`:${expected}`)}` || header === `Bearer ${expected}`;
      if (!ok) {
        return json({ message: "Invalid credentials" }, 401);
      }
    }
    const url = new URL(request.url);
    const path = url.pathname;
    const repoPrefix = `/${this.options.organization}/${encodeURIComponent(this.options.project)}/_apis/git/repositories/`;
    if (!path.startsWith(repoPrefix) && !path.includes("/_apis/git/repositories/")) {
      return json({ message: "Not found" }, 404);
    }
    const rest = path.split("/_apis/git/repositories/")[1] ?? "";
    const [repoKey, ...parts] = rest.split("/");
    if (
      repoKey !== this.repository.id &&
      repoKey !== encodeURIComponent(this.repository.name) &&
      repoKey !== this.repository.name
    ) {
      return json({ message: "Repository not found" }, 404);
    }
    if (parts.length === 0 || (parts.length === 1 && parts[0] === "")) {
      return json(this.repository);
    }
    if (parts[0] === "pullrequests" || parts[0] === "pullRequests") {
      return this.handlePullRequests(request, url, parts.slice(1));
    }
    return json({ message: `No fake route for ${path}` }, 404);
  }

  private async handlePullRequests(request: Request, url: URL, parts: string[]): Promise<Response> {
    if (parts.length === 0) {
      if (request.method === "GET") {
        return this.listPullRequests(url);
      }
      if (request.method === "POST") {
        const body = (await request.json()) as {
          sourceRefName: string;
          targetRefName: string;
          title: string;
          description?: string;
        };
        const id = this.nextId++;
        const pr: StoredPr = {
          pullRequestId: id,
          title: body.title,
          description: body.description ?? "",
          status: "active",
          sourceRefName: body.sourceRefName,
          targetRefName: body.targetRefName,
          reviewers: [],
          properties: {},
        };
        this.pullRequests.set(id, pr);
        return json(pr, 201);
      }
    }
    const id = Number(parts[0]);
    const pr = this.pullRequests.get(id);
    if (!pr) {
      return json({ message: `Pull request ${id} not found` }, 404);
    }
    if (parts[1] === "properties") {
      if (request.method === "GET") {
        return json({ count: Object.keys(pr.properties).length, value: wrap(pr.properties) });
      }
      if (request.method === "PATCH") {
        const ops = (await request.json()) as Array<{ op: string; path: string; value?: string }>;
        for (const op of ops) {
          const key = op.path.replace(/^\//, "");
          if (op.op === "remove") {
            delete pr.properties[key];
          } else if (typeof op.value === "string") {
            pr.properties[key] = op.value;
          }
        }
        return json({ count: Object.keys(pr.properties).length, value: wrap(pr.properties) });
      }
    }
    if (request.method === "GET") {
      return json(pr);
    }
    if (request.method === "PATCH") {
      const body = (await request.json()) as {
        title?: string;
        description?: string;
        targetRefName?: string;
        status?: PullRequestStatus;
      };
      if (body.targetRefName) {
        if (this.failTarget === body.targetRefName) {
          return json({ message: `Branch ${body.targetRefName} does not exist` }, 400);
        }
        pr.targetRefName = body.targetRefName;
      }
      if (body.title) {
        pr.title = body.title;
      }
      if (body.description !== undefined) {
        pr.description = body.description;
      }
      if (body.status) {
        pr.status = body.status;
      }
      return json(pr);
    }
    return json({ message: "Unsupported" }, 400);
  }

  private listPullRequests(url: URL): Response {
    const status = url.searchParams.get("searchCriteria.status") ?? "all";
    const source = url.searchParams.get("searchCriteria.sourceRefName");
    const target = url.searchParams.get("searchCriteria.targetRefName");
    const top = Number(url.searchParams.get("$top") ?? "100");
    const continuation = Number(url.searchParams.get("continuationToken") ?? "0");
    let items = [...this.pullRequests.values()];
    if (status !== "all") {
      items = items.filter((pr) => pr.status === status);
    }
    if (source) {
      items = items.filter((pr) => pr.sourceRefName === source);
    }
    if (target) {
      items = items.filter((pr) => pr.targetRefName === target);
    }
    const slice = items.slice(continuation, continuation + top);
    const headers = new Headers({ "Content-Type": "application/json" });
    if (continuation + top < items.length) {
      headers.set("x-ms-continuationtoken", String(continuation + top));
    }
    return new Response(JSON.stringify({ count: items.length, value: slice }), { headers });
  }
}

function wrap(
  properties: Record<string, string>,
): Record<string, { $type: string; $value: string }> {
  const value: Record<string, { $type: string; $value: string }> = {};
  for (const [key, item] of Object.entries(properties)) {
    value[key] = { $type: "System.String", $value: item };
  }
  return value;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
