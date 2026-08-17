import { CliError } from "../errors/cli-error.ts";

export const MANAGED_START = "<!-- ado-stack:start -->";
export const MANAGED_END = "<!-- ado-stack:end -->";

export type StackDescriptionItem = {
  id: number;
  title: string;
  current: boolean;
};

export function generateStackBlock(items: StackDescriptionItem[]): string {
  const lines = items.map((item) => {
    const label = `- #${item.id} ${item.title}`;
    return item.current ? `- **#${item.id} ${item.title}**` : label;
  });
  return [MANAGED_START, "### Stack", "", ...lines, "", "Managed by ado-stack.", MANAGED_END].join(
    "\n",
  );
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
