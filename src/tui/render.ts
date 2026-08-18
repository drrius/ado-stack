import pc from "picocolors";
import {
  type PrDisplay,
  type StackStatus,
  type StatusRow,
  forestLayout,
  prStatusLabel,
} from "../commands/status.ts";
import { formatBranch } from "../ui/format.ts";

export function renderStackLines(status: StackStatus, prefix: string): string[] {
  const lines: string[] = [];
  const notice = accessNotice(status);
  if (notice) {
    lines.push(pc.yellow(notice));
    lines.push("");
  }
  lines.push(`  ${pc.dim(`${formatBranch(status.defaultBranch, prefix)} (trunk)`)}`);
  if (status.rows.length === 0) {
    lines.push(`  ${pc.dim("(empty)")}`);
  }
  for (const line of forestLayout(status.rows, status.defaultBranch)) {
    lines.push(rowLine(line.row, prefix, `  ${line.prefix}${line.connector}`));
    if (line.row.pr.kind === "loaded") {
      const hanging = line.connector === "└── " ? "    " : "│   ";
      lines.push(`  ${line.prefix}${hanging}    ${pc.dim(line.row.pr.url)}`);
    }
  }
  for (const issue of status.issues) {
    lines.push(pc.yellow(`  note: ${issue}`));
  }
  const next = nextHint(status);
  if (next) {
    lines.push("");
    lines.push(next);
  }
  return lines;
}

function rowLine(row: StatusRow, prefix: string, tree: string): string {
  const marker = row.isCurrent ? pc.green("●") : " ";
  const name = formatBranch(row.branch, prefix);
  const prLabel = row.pr.kind === "none" ? "no-pr" : `#${row.pr.id}`;
  const flags: string[] = [];
  if (row.needsRestack) {
    flags.push(pc.yellow("↑ restack needed"));
  } else if (row.pr.kind === "loaded") {
    flags.push(pc.green("✓ synced"));
  }
  if (row.diverged) {
    flags.push(pc.red("local/remote diverge"));
  }
  const title = row.pr.kind === "loaded" && row.pr.title ? `  ${row.pr.title}` : "";
  const labeled = row.isCurrent ? pc.bold(name) : name;
  return `${tree}${marker} ${labeled} ${prLabel} ${statusLabel(row.pr)}${title}${
    flags.length > 0 ? `  ${flags.join("  ")}` : ""
  }`.trimEnd();
}

function statusLabel(pr: PrDisplay): string {
  const label = prStatusLabel(pr);
  switch (pr.kind) {
    case "none":
      return pc.dim(label);
    case "unknown":
      return pc.yellow(label);
    case "loaded":
      return loadedLabel(pr.state, label);
    default: {
      const _exhaustive: never = pr;
      return _exhaustive;
    }
  }
}

function loadedLabel(
  state: Extract<PrDisplay, { kind: "loaded" }>["state"],
  label: string,
): string {
  switch (state) {
    case "open":
      return pc.cyan(label);
    case "approved":
      return pc.green(label);
    case "rejected":
      return pc.red(label);
    case "completed":
      return pc.magenta(label);
    case "abandoned":
      return pc.dim(label);
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

function accessNotice(status: StackStatus): string | undefined {
  if (status.ado.kind === "unavailable") {
    return status.ado.reason === "unauthenticated"
      ? "Not authenticated to Azure DevOps. PR status is unknown."
      : `Azure DevOps unavailable: ${status.ado.message}`;
  }
  if (status.ado.loadError !== undefined) {
    return `Azure DevOps status is incomplete: ${status.ado.loadError}`;
  }
  return undefined;
}

function nextHint(status: StackStatus): string | undefined {
  switch (status.next) {
    case "auth-login":
      return `Next: ${pc.bold("log in to Azure DevOps")} (Authentication)`;
    case "create":
      return `Next: ${pc.bold("create a stack branch")}`;
    case "submit":
      return `Next: ${pc.bold("submit the stack")}`;
    case "restack":
      return `Next: ${pc.bold("restack onto latest parents")}`;
    case "none":
      if (status.rows.length === 0) {
        return undefined;
      }
      return pc.green("Stack is in sync.");
    default: {
      const _exhaustive: never = status.next;
      return _exhaustive;
    }
  }
}
