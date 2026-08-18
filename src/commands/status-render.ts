import { CliError } from "../errors/cli-error.ts";
import type { StackState } from "../state/schema.ts";
import { displayWidth, ellipsizeToWidth } from "../ui/display-width.ts";
import { formatBranch, pullRequestWebUrl } from "../ui/format.ts";
import {
  type ForestLine,
  type PrDisplay,
  type PrState,
  type StackStatus,
  type StatusRow,
  forestLayout,
  prStatusLabel,
  rowFlags,
} from "./status-model.ts";

export const DEFAULT_STATUS_WIDTH = 100;

export type StatusTextOptions = {
  width: number;
  urls: boolean;
  branchPrefix: string;
  state: StackState;
};

export type StatusJsonPullRequestStatus = "none" | "unknown" | PrState;

export type StatusJsonNode = {
  branch: string;
  parent: string;
  current: boolean;
  pullRequestNumber: number | null;
  pullRequestStatus: StatusJsonPullRequestStatus;
  title: string | null;
  url: string | null;
  needsRestack: boolean;
  diverged: boolean;
  ahead: number;
  behind: number;
  children: StatusJsonNode[];
};

export type StatusJson = {
  defaultBranch: string;
  currentBranch: string;
  organization: string;
  project: string;
  repository: string;
  forest: StatusJsonNode[];
};

export function parseStatusWidth(value: string | boolean | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw new CliError("--width requires a positive integer.");
  }
  return Number(value);
}

export function resolveStatusWidth(input: {
  explicit?: number;
  stdoutColumns?: number;
  columnsEnv?: string;
}): number {
  if (input.explicit !== undefined) {
    return input.explicit;
  }
  if (input.stdoutColumns !== undefined && input.stdoutColumns > 0) {
    return input.stdoutColumns;
  }
  const fromEnv = input.columnsEnv === undefined ? Number.NaN : Number(input.columnsEnv);
  if (Number.isInteger(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  return DEFAULT_STATUS_WIDTH;
}

export function formatForestRows(status: StackStatus, options: StatusTextOptions): string[] {
  return forestLayout(status.rows, status.defaultBranch).map((line) =>
    formatForestRow(line, options),
  );
}

function formatForestRow(line: ForestLine, options: StatusTextOptions): string {
  const glyphs = `  ${line.prefix}${line.connector}`;
  const pr = line.row.pr.kind === "none" ? "no-pr" : `#${line.row.pr.id}`;
  const branch = formatBranch(line.row.branch, options.branchPrefix);
  const state = [prStatusLabel(line.row.pr), ...rowFlags(line.row)].join("  ");
  const title = line.row.pr.kind === "loaded" && line.row.pr.title ? line.row.pr.title : "";
  const url = options.urls ? pullRequestUrl(line.row.pr, options.state) : "";
  return fitStatusRow({
    glyphs,
    pr,
    branch,
    state,
    title,
    url,
    width: options.width,
  });
}

export function toStatusJson(status: StackStatus, state: StackState): StatusJson {
  const layout = forestLayout(status.rows, status.defaultBranch);
  const nodes = new Map<string, StatusJsonNode>();
  for (const line of layout) {
    nodes.set(line.row.branch, rowToJsonNode(line.row, state));
  }
  const forest: StatusJsonNode[] = [];
  for (const line of layout) {
    const node = nodes.get(line.row.branch);
    if (!node) {
      continue;
    }
    if (line.row.parent === status.defaultBranch) {
      forest.push(node);
      continue;
    }
    nodes.get(line.row.parent)?.children.push(node);
  }
  return {
    defaultBranch: status.defaultBranch,
    currentBranch: status.currentBranch,
    organization: state.organization,
    project: state.project,
    repository: state.repository,
    forest,
  };
}

function rowToJsonNode(row: StatusRow, state: StackState): StatusJsonNode {
  return {
    branch: row.branch,
    parent: row.parent,
    current: row.isCurrent,
    pullRequestNumber: row.pr.kind === "none" ? null : row.pr.id,
    pullRequestStatus: jsonPullRequestStatus(row.pr),
    title: row.pr.kind === "loaded" ? row.pr.title : null,
    url: jsonPullRequestUrl(row.pr, state),
    needsRestack: row.needsRestack,
    diverged: row.diverged,
    ahead: row.ahead,
    behind: row.behind,
    children: [],
  };
}

function jsonPullRequestStatus(pr: PrDisplay): StatusJsonPullRequestStatus {
  switch (pr.kind) {
    case "none":
      return "none";
    case "unknown":
      return "unknown";
    case "loaded":
      return pr.state;
    default: {
      const _exhaustive: never = pr;
      return _exhaustive;
    }
  }
}

function jsonPullRequestUrl(pr: PrDisplay, state: StackState): string | null {
  switch (pr.kind) {
    case "none":
      return null;
    case "unknown":
      return pullRequestWebUrl(state, pr.id);
    case "loaded":
      return pr.url;
    default: {
      const _exhaustive: never = pr;
      return _exhaustive;
    }
  }
}

function pullRequestUrl(pr: PrDisplay, state: StackState): string {
  return jsonPullRequestUrl(pr, state) ?? "";
}

function fitStatusRow(parts: {
  glyphs: string;
  pr: string;
  branch: string;
  state: string;
  title: string;
  url: string;
  width: number;
}): string {
  const full = renderStatusRow(parts, parts.branch, parts.title, parts.url);
  if (displayWidth(full) <= parts.width) {
    return full;
  }

  if (parts.url) {
    const withoutUrl = renderStatusRow(parts, parts.branch, parts.title, "");
    const urlRoom = parts.width - displayWidth(withoutUrl) - 2;
    if (urlRoom > 0) {
      return renderStatusRow(parts, parts.branch, parts.title, ellipsizeToWidth(parts.url, urlRoom));
    }
  }

  const withoutFlexible = renderStatusRow(parts, parts.branch, "", "");
  if (displayWidth(withoutFlexible) <= parts.width) {
    const titleRoom = parts.width - displayWidth(withoutFlexible) - 2;
    if (titleRoom > 0 && parts.title) {
      return renderStatusRow(parts, parts.branch, ellipsizeToWidth(parts.title, titleRoom), "");
    }
    return withoutFlexible;
  }

  const base = `${parts.glyphs}${parts.pr}  ${parts.state}`;
  const branchRoom = parts.width - displayWidth(base) - 1;
  if (branchRoom <= 0) {
    return `${parts.glyphs}${parts.pr}  ${parts.state}`;
  }
  return renderStatusRow(parts, ellipsizeToWidth(parts.branch, branchRoom), "", "");
}

function renderStatusRow(
  parts: { glyphs: string; pr: string; state: string },
  branch: string,
  title: string,
  url: string,
): string {
  let line = `${parts.glyphs}${parts.pr}`;
  if (branch) {
    line += ` ${branch}`;
  }
  line += `  ${parts.state}`;
  if (title) {
    line += `  ${title}`;
  }
  if (url) {
    line += `  ${url}`;
  }
  return line;
}
