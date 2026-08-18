export type PrState = "open" | "approved" | "rejected" | "completed" | "abandoned";

export type PrDisplay =
  | { kind: "none" }
  | { kind: "unknown"; id: number }
  | { kind: "loaded"; id: number; title: string; url: string; state: PrState };

export type StatusRow = {
  branch: string;
  parent: string;
  pr: PrDisplay;
  isCurrent: boolean;
  needsRestack: boolean;
  diverged: boolean;
  ahead: number;
  behind: number;
};

export type ForestLine = { prefix: string; connector: string; row: StatusRow };

export type AdoStatusAccess =
  | { kind: "ready"; loadError?: string }
  | { kind: "unavailable"; reason: "unauthenticated" | "error"; message: string };

export type NextStep = "auth-login" | "create" | "submit" | "restack" | "none";

export type StackStatus = {
  rows: StatusRow[];
  currentBranch: string;
  defaultBranch: string;
  ado: AdoStatusAccess;
  issues: string[];
  next: NextStep;
};

export function prStatusLabel(pr: PrDisplay): string {
  switch (pr.kind) {
    case "none":
      return "LOCAL";
    case "unknown":
      return "UNKNOWN";
    case "loaded":
      return pr.state.toUpperCase();
    default: {
      const _exhaustive: never = pr;
      throw new Error(`Unhandled PR display ${String(_exhaustive)}`);
    }
  }
}

export function rowFlags(row: StatusRow): string[] {
  const flags: string[] = [];
  if (row.isCurrent) {
    flags.push("current");
  }
  if (row.needsRestack) {
    flags.push("↑ restack needed");
  } else if (row.pr.kind === "loaded") {
    flags.push("✓ synced");
  }
  if (row.diverged) {
    flags.push("local/remote diverge");
  }
  return flags;
}

export function forestLayout(rows: StatusRow[], defaultBranch: string): ForestLine[] {
  const byParent = new Map<string, StatusRow[]>();
  for (const row of rows) {
    const list = byParent.get(row.parent) ?? [];
    list.push(row);
    byParent.set(row.parent, list);
  }
  const lines: ForestLine[] = [];
  const walk = (parent: string, prefix: string): void => {
    const children = byParent.get(parent) ?? [];
    for (const [index, row] of children.entries()) {
      if (!row) {
        continue;
      }
      const last = index === children.length - 1;
      lines.push({ prefix, connector: last ? "└── " : "├── ", row });
      walk(row.branch, `${prefix}${last ? "    " : "│   "}`);
    }
  };
  walk(defaultBranch, "");
  return lines;
}
