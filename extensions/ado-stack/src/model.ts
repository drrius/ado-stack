export type StatusPreflight =
  | { kind: "not-needed" }
  | { kind: "clean" }
  | { kind: "conflicts"; files: string[] }
  | { kind: "error"; message: string };

export type StatusJsonNode = {
  branch: string;
  parent: string;
  current: boolean;
  pullRequestNumber: number | null;
  pullRequestStatus: string;
  title: string | null;
  url: string | null;
  needsRestack: boolean;
  diverged: boolean;
  ahead: number;
  behind: number;
  children: StatusJsonNode[];
  preflight?: StatusPreflight;
};

export type StatusJson = {
  defaultBranch: string;
  currentBranch: string;
  organization: string;
  project: string;
  repository: string;
  forest: StatusJsonNode[];
};

export function parseStatusJson(text: string): StatusJson {
  const parsed: unknown = JSON.parse(text);
  if (
    !isRecord(parsed) ||
    !Array.isArray(parsed.forest) ||
    typeof parsed.defaultBranch !== "string"
  ) {
    throw new Error("ado-stack --json did not return a forest.");
  }
  return {
    defaultBranch: parsed.defaultBranch,
    currentBranch: stringField(parsed, "currentBranch"),
    organization: stringField(parsed, "organization"),
    project: stringField(parsed, "project"),
    repository: stringField(parsed, "repository"),
    forest: parsed.forest.map((node) => parseNode(node)),
  };
}

export function flattenForest(forest: StatusJsonNode[]): StatusJsonNode[] {
  const rows: StatusJsonNode[] = [];
  const walk = (node: StatusJsonNode): void => {
    rows.push(node);
    for (const child of node.children) {
      walk(child);
    }
  };
  for (const node of forest) {
    walk(node);
  }
  return rows;
}

export function stackPosition(model: StatusJson): {
  current: StatusJsonNode | undefined;
  index: number;
  total: number;
} {
  const rows = flattenForest(model.forest);
  const index = rows.findIndex((row) => row.current || row.branch === model.currentBranch);
  return {
    current: index >= 0 ? rows[index] : undefined,
    index: index >= 0 ? index + 1 : 0,
    total: rows.length,
  };
}

function parseNode(value: unknown): StatusJsonNode {
  if (!isRecord(value) || typeof value.branch !== "string" || typeof value.parent !== "string") {
    throw new Error("ado-stack --json node is missing branch or parent.");
  }
  return {
    branch: value.branch,
    parent: value.parent,
    current: value.current === true,
    pullRequestNumber: typeof value.pullRequestNumber === "number" ? value.pullRequestNumber : null,
    pullRequestStatus:
      typeof value.pullRequestStatus === "string" ? value.pullRequestStatus : "none",
    title: typeof value.title === "string" ? value.title : null,
    url: typeof value.url === "string" ? value.url : null,
    needsRestack: value.needsRestack === true,
    diverged: value.diverged === true,
    ahead: typeof value.ahead === "number" ? value.ahead : 0,
    behind: typeof value.behind === "number" ? value.behind : 0,
    children: Array.isArray(value.children) ? value.children.map((child) => parseNode(child)) : [],
    preflight: parsePreflight(value.preflight),
  };
}

function parsePreflight(value: unknown): StatusPreflight | undefined {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return undefined;
  }
  if (value.kind === "not-needed" || value.kind === "clean") {
    return { kind: value.kind };
  }
  if (value.kind === "conflicts") {
    const files = Array.isArray(value.files)
      ? value.files.filter((file): file is string => typeof file === "string")
      : [];
    return { kind: "conflicts", files };
  }
  if (value.kind === "error") {
    return {
      kind: "error",
      message: typeof value.message === "string" ? value.message : "preflight failed",
    };
  }
  return undefined;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  return typeof field === "string" ? field : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
