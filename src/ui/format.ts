import { displayName } from "../stack/names.ts";
import type { StackState } from "../state/schema.ts";

export function formatBranch(branch: string, prefix: string): string {
  return displayName(branch, prefix);
}

export function pullRequestWebUrl(state: StackState, id: number): string {
  const project = encodeURIComponent(state.project);
  const repository = encodeURIComponent(state.repository);
  return `${trimSlash(state.organization)}/${project}/_git/${repository}/pullrequest/${id}`;
}

export function formatStackPrChain(ids: number[]): string {
  return ids.map((id) => `#${id}`).join(" → ");
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
