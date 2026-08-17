import { AdoError, adoErrorFromResponse, classifyHttpStatus } from "./errors.ts";
import type { JsonPatchOp } from "./properties.ts";
import type {
  AdoPullRequest,
  AdoRepository,
  CreatePullRequestInput,
  PullRequestStatus,
  UpdatePullRequestInput,
} from "./types.ts";
import { redactHeaders, redactText } from "../ui/redact.ts";

export const API_VERSION = "7.1";

export type AdoClientOptions = {
  organizationUrl: string;
  project: string;
  repositoryId: string;
  authorization: string;
  fetch?: typeof fetch;
  apiVersion?: string;
  logger?: { debug: (message: string) => void };
};

export class AdoClient {
  private readonly fetchImpl: typeof fetch;
  private readonly apiVersion: string;

  constructor(private readonly options: AdoClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.apiVersion = options.apiVersion ?? API_VERSION;
  }

  async getRepository(): Promise<AdoRepository> {
    return this.request<AdoRepository>("get repository", "GET", this.repoPath(""));
  }

  async listPullRequests(
    options: {
      status?: PullRequestStatus | "all";
      sourceRefName?: string;
      targetRefName?: string;
      creatorId?: string;
    } = {},
  ): Promise<AdoPullRequest[]> {
    const results: AdoPullRequest[] = [];
    let continuation: string | undefined;
    do {
      const query: Record<string, string> = {
        "searchCriteria.status": options.status ?? "all",
        $top: "100",
      };
      if (options.sourceRefName) {
        query["searchCriteria.sourceRefName"] = options.sourceRefName;
      }
      if (options.targetRefName) {
        query["searchCriteria.targetRefName"] = options.targetRefName;
      }
      if (options.creatorId) {
        query["searchCriteria.creatorId"] = options.creatorId;
      }
      if (continuation) {
        query.continuationToken = continuation;
      }
      const { body, headers } = await this.requestWithHeaders<AdoPullRequest[]>(
        "list pull requests",
        "GET",
        this.repoPath("/pullrequests"),
        { query },
      );
      results.push(...body);
      continuation = headers.get("x-ms-continuationtoken") ?? undefined;
    } while (continuation);
    return results;
  }

  async getPullRequest(id: number): Promise<AdoPullRequest> {
    return this.request<AdoPullRequest>(
      `get pull request #${id}`,
      "GET",
      this.repoPath(`/pullrequests/${id}`),
    );
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<AdoPullRequest> {
    return this.request<AdoPullRequest>(
      "create pull request",
      "POST",
      this.repoPath("/pullrequests"),
      { body: input },
    );
  }

  async updatePullRequest(id: number, input: UpdatePullRequestInput): Promise<AdoPullRequest> {
    return this.request<AdoPullRequest>(
      `update pull request #${id}`,
      "PATCH",
      this.repoPath(`/pullrequests/${id}`),
      { body: input },
    );
  }

  async getPullRequestProperties(id: number): Promise<Record<string, string>> {
    const raw = await this.request<unknown>(
      `get PR #${id} properties`,
      "GET",
      this.repoPath(`/pullrequests/${id}/properties`),
    );
    return flattenProperties(raw);
  }

  async updatePullRequestProperties(
    id: number,
    ops: JsonPatchOp[],
  ): Promise<Record<string, string>> {
    const raw = await this.request<unknown>(
      `update PR #${id} properties`,
      "PATCH",
      this.repoPath(`/pullrequests/${id}/properties`),
      {
        body: ops,
        contentType: "application/json-patch+json",
      },
    );
    return flattenProperties(raw);
  }

  async findActivePullRequestBySource(sourceBranch: string): Promise<AdoPullRequest | undefined> {
    const ref = sourceBranch.startsWith("refs/") ? sourceBranch : `refs/heads/${sourceBranch}`;
    const matches = await this.listPullRequests({
      status: "active",
      sourceRefName: ref,
    });
    return matches[0];
  }

  private repoPath(suffix: string): string {
    const project = encodeURIComponent(this.options.project);
    const repo = encodeURIComponent(this.options.repositoryId);
    return `/${project}/_apis/git/repositories/${repo}${suffix}`;
  }

  private async request<T>(
    operation: string,
    method: string,
    path: string,
    init: {
      query?: Record<string, string>;
      body?: unknown;
      contentType?: string;
    } = {},
  ): Promise<T> {
    const { body } = await this.requestWithHeaders<T>(operation, method, path, init);
    return body;
  }

  private async requestWithHeaders<T>(
    operation: string,
    method: string,
    path: string,
    init: {
      query?: Record<string, string>;
      body?: unknown;
      contentType?: string;
    } = {},
  ): Promise<{ body: T; headers: Headers }> {
    const url = new URL(path.replace(/^\//, ""), `${trimSlash(this.options.organizationUrl)}/`);
    url.searchParams.set("api-version", this.apiVersion);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      url.searchParams.set(key, value);
    }
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: this.options.authorization,
    };
    if (init.body !== undefined) {
      headers["Content-Type"] = init.contentType ?? "application/json";
    }
    this.options.logger?.debug(
      `${method} ${redactText(url.toString())} headers=${JSON.stringify(redactHeaders(headers))}`,
    );
    const response = await this.fetchWithRetry(url, {
      method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await response.text();
    const parsed: unknown = text.length === 0 ? undefined : tryJson(text);
    if (!response.ok) {
      throw adoErrorFromResponse({
        status: response.status,
        body: parsed,
        operation,
      });
    }
    return { body: parsed as T, headers: response.headers };
  }

  private async fetchWithRetry(url: URL, init: RequestInit): Promise<Response> {
    let last: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      last = await this.fetchImpl(url, init);
      const kind = classifyHttpStatus(last.status);
      if (kind !== "rate-limited" && kind !== "server") {
        return last;
      }
      await sleep(200 * 2 ** attempt);
    }
    if (!last) {
      throw new AdoError({
        status: 0,
        kind: "unknown",
        message: `Azure DevOps request to ${url.pathname} failed before a response.`,
      });
    }
    return last;
  }
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function flattenProperties(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const record = raw as Record<string, unknown>;
  const inner = isRecord(record.value) ? record.value : record;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(inner)) {
    if (typeof value === "string") {
      result[key] = value;
      continue;
    }
    if (isRecord(value) && typeof value.$value === "string") {
      result[key] = value.$value;
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
