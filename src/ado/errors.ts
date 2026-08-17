import { CliError } from "../errors/cli-error.ts";

export type AdoFailureKind =
  | "unauthenticated"
  | "expired"
  | "forbidden"
  | "not-found"
  | "bad-request"
  | "conflict"
  | "rate-limited"
  | "server"
  | "unknown";

export type AdoErrorBody = {
  message?: string;
  typeKey?: string;
  typeName?: string;
  errorCode?: number;
};

export function parseAdoErrorBody(value: unknown): AdoErrorBody {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const record = value as Record<string, unknown>;
  const body: AdoErrorBody = {};
  if (typeof record.message === "string") {
    body.message = record.message;
  }
  if (typeof record.typeKey === "string") {
    body.typeKey = record.typeKey;
  }
  if (typeof record.typeName === "string") {
    body.typeName = record.typeName;
  }
  if (typeof record.errorCode === "number") {
    body.errorCode = record.errorCode;
  }
  return body;
}

export function classifyHttpStatus(status: number): AdoFailureKind {
  if (status === 401) {
    return "unauthenticated";
  }
  if (status === 403) {
    return "forbidden";
  }
  if (status === 404) {
    return "not-found";
  }
  if (status === 400) {
    return "bad-request";
  }
  if (status === 409) {
    return "conflict";
  }
  if (status === 429) {
    return "rate-limited";
  }
  if (status >= 500) {
    return "server";
  }
  return "unknown";
}

export class AdoError extends CliError {
  readonly status: number;
  readonly kind: AdoFailureKind;
  readonly typeKey: string | undefined;

  constructor(options: {
    status: number;
    kind: AdoFailureKind;
    message: string;
    hint?: string;
    typeKey?: string;
  }) {
    super(options.message, { hint: options.hint, exitCode: 1 });
    this.name = "AdoError";
    this.status = options.status;
    this.kind = options.kind;
    this.typeKey = options.typeKey;
  }
}

export function adoErrorFromResponse(options: {
  status: number;
  body: unknown;
  operation: string;
}): AdoError {
  const parsed = parseAdoErrorBody(options.body);
  const kind = classifyHttpStatus(options.status);
  const serverMessage = parsed.message?.trim();
  const message = humanAdoMessage(kind, options.operation, serverMessage);
  return new AdoError({
    status: options.status,
    kind,
    message,
    typeKey: parsed.typeKey,
    hint: hintFor(kind),
  });
}

function humanAdoMessage(
  kind: AdoFailureKind,
  operation: string,
  serverMessage: string | undefined,
): string {
  const suffix = serverMessage ? `\n\n${serverMessage}` : "";
  switch (kind) {
    case "unauthenticated":
      return `Azure DevOps rejected the credentials used to ${operation}.${suffix}\n\nRun \`ado-stack auth login\` to update authentication.`;
    case "expired":
      return `Azure DevOps credentials expired while trying to ${operation}.${suffix}`;
    case "forbidden":
      return `Azure DevOps denied permission to ${operation}.${suffix}\n\nThe token needs Code (Read & Write) and Pull Request (Read & Write) on this repository.`;
    case "not-found":
      return `Azure DevOps could not find the organization, project, or repository needed to ${operation}.${suffix}\n\nCheck \`ado-stack config list\` and that your account can open the repo in the browser.`;
    case "bad-request":
      return `Azure DevOps rejected the request to ${operation}.${suffix}`;
    case "conflict":
      return `Azure DevOps reported a conflict while trying to ${operation}.${suffix}`;
    case "rate-limited":
      return `Azure DevOps rate-limited the request to ${operation}. Wait and retry.`;
    case "server":
      return `Azure DevOps returned a server error while trying to ${operation}.${suffix}`;
    case "unknown":
      return `Azure DevOps request failed while trying to ${operation}.${suffix}`;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

function hintFor(kind: AdoFailureKind): string | undefined {
  switch (kind) {
    case "unauthenticated":
    case "expired":
      return "Set AZURE_DEVOPS_EXT_PAT, run `ado-stack auth login`, or run `az login`.";
    case "not-found":
      return "Run `ado-stack init` with `--organization`, `--project`, and `--repository` if remote detection failed.";
    default:
      return undefined;
  }
}

export function targetBranchGoneMessage(branch: string): string {
  return `Azure DevOps rejected the PR update because the target branch no longer exists:\n\nrefs/heads/${branch}\n\nRun \`ado-stack status\` to inspect the current stack.`;
}
