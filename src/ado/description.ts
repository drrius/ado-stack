import { CliError } from "../errors/cli-error.ts";

export const MANAGED_START = "<!-- ado-stack:start -->";
export const MANAGED_END = "<!-- ado-stack:end -->";

export type StackDescriptionItem = {
  id: number;
  title: string;
  current: boolean;
  branch?: string;
  parent?: string;
};

export function generateStackBlock(items: StackDescriptionItem[]): string {
  const lines = items.every(hasParentLinks)
    ? descriptionTree(items)
    : items.map((item) => {
        const label = `- #${item.id} ${item.title}`;
        return item.current ? `- **#${item.id} ${item.title}**` : label;
      });
  return [MANAGED_START, "### Stack", "", ...lines, "", "Managed by ado-stack.", MANAGED_END].join(
    "\n",
  );
}

function hasParentLinks(
  item: StackDescriptionItem,
): item is StackDescriptionItem & { branch: string; parent: string } {
  return Boolean(item.branch && item.parent);
}

function descriptionTree(
  items: Array<StackDescriptionItem & { branch: string; parent: string }>,
): string[] {
  const byParent = new Map<string, typeof items>();
  const branches = new Set(items.map((item) => item.branch));
  for (const item of items) {
    const list = byParent.get(item.parent) ?? [];
    list.push(item);
    byParent.set(item.parent, list);
  }
  const roots = [...byParent.keys()].filter((parent) => !branches.has(parent));
  const lines: string[] = [];
  const walk = (parent: string, prefix: string): void => {
    const children = byParent.get(parent) ?? [];
    for (const [index, item] of children.entries()) {
      if (!item) {
        continue;
      }
      const last = index === children.length - 1;
      const connector = last ? "└── " : "├── ";
      const label = `#${item.id} ${item.title}`;
      lines.push(`${prefix}${connector}${item.current ? `**${label}**` : label}`);
      walk(item.branch, `${prefix}${last ? "    " : "│   "}`);
    }
  };
  for (const root of roots) {
    walk(root, "");
  }
  return lines;
}

export function upsertManagedSection(description: string, block: string): string {
  const start = description.indexOf(MANAGED_START);
  const end = description.indexOf(MANAGED_END);
  if (start >= 0 && end > start) {
    const afterEnd = end + MANAGED_END.length;
    return `${description.slice(0, start)}${block}${description.slice(afterEnd)}`.replace(
      /\n{3,}/g,
      "\n\n",
    );
  }
  const trimmed = description.trimEnd();
  if (!trimmed) {
    return `${block}\n`;
  }
  return `${trimmed}\n\n${block}\n`;
}

export function humanDescription(description: string): string {
  const start = description.indexOf(MANAGED_START);
  const end = description.indexOf(MANAGED_END);
  if (start < 0 || end < start) {
    return description;
  }
  return `${description.slice(0, start)}${description.slice(end + MANAGED_END.length)}`
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const PR_DESCRIPTION_LIMIT = 4000;

export function assertDescriptionLimit(description: string): void {
  if (description.length <= PR_DESCRIPTION_LIMIT) {
    return;
  }
  throw new CliError(
    `Azure DevOps PR descriptions are limited to ${PR_DESCRIPTION_LIMIT} characters. The managed stack block plus the existing description is ${description.length} characters. Shorten the human-authored description and retry.`,
  );
}
