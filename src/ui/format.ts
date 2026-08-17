import { displayName } from "../stack/names.ts";
import type { StackState } from "../state/schema.ts";

export function formatBranch(branch: string, prefix: string): string {
  return displayName(branch, prefix);
}

export function pullRequestWebUrl(state: StackState, id: number): string {
  return `${trimSlash(state.organization)}/${state.project}/_git/${state.repository}/pullrequest/${id}`;
}

export function formatStackPrChain(ids: number[]): string {
  return ids.map((id) => `#${id}`).join(" → ");
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
