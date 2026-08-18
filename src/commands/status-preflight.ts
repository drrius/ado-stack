import type { GitRepo } from "../git/git.ts";
import { parseContentConflictPaths } from "../git/merge-tree.ts";
import { resolveOntoSha } from "../stack/restack.ts";
import type { StackState } from "../state/schema.ts";
import type { StatusJson, StatusJsonNode, StatusPreflight } from "./status-render.ts";

export async function attachPreflight(
  git: GitRepo,
  state: StackState,
  model: StatusJson,
): Promise<StatusJson> {
  return {
    ...model,
    forest: await Promise.all(model.forest.map((node) => withPreflight(git, state, node))),
  };
}

async function withPreflight(
  git: GitRepo,
  state: StackState,
  node: StatusJsonNode,
): Promise<StatusJsonNode> {
  return {
    ...node,
    preflight: await preflightFor(git, state, node),
    children: await Promise.all(node.children.map((child) => withPreflight(git, state, child))),
  };
}

export async function preflightFor(
  git: GitRepo,
  state: StackState,
  node: Pick<StatusJsonNode, "branch" | "parent" | "needsRestack">,
): Promise<StatusPreflight> {
  if (!node.needsRestack) {
    return { kind: "not-needed" };
  }
  try {
    const parentSha = await resolveOntoSha(git, state, node.parent);
    const branchSha = await git.getBranchTip(node.branch);
    const mergeBase = await git.mergeBase(parentSha, branchSha);
    if (!mergeBase) {
      return { kind: "error", message: `No merge-base between ${node.parent} and ${node.branch}.` };
    }
    const result = await git.mergeTree({
      mergeBase,
      ours: parentSha,
      theirs: branchSha,
    });
    const files = parseContentConflictPaths(`${result.stdout}\n${result.stderr}`);
    if (result.exitCode === 0 && files.length === 0) {
      return { kind: "clean" };
    }
    if (files.length > 0) {
      return { kind: "conflicts", files };
    }
    const detail = result.stderr.trim() || result.stdout.trim();
    return {
      kind: "error",
      message: detail || `merge-tree exited ${result.exitCode}.`,
    };
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
}
