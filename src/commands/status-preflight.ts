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
    forest: await Promise.all(model.forest.map((node) => withPreflight(git, state, node, false))),
  };
}

async function withPreflight(
  git: GitRepo,
  state: StackState,
  node: StatusJsonNode,
  parentMoving: boolean,
  rewrittenParent?: string,
): Promise<StatusJsonNode> {
  const willMove = node.needsRestack || parentMoving;
  const replay = willMove
    ? await replayRestack(git, state, node, rewrittenParent)
    : { preflight: { kind: "not-needed" } as const, onto: undefined };
  return {
    ...node,
    preflight: replay.preflight,
    children: await Promise.all(
      node.children.map((child) => withPreflight(git, state, child, willMove, replay.onto)),
    ),
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
  return (await replayRestack(git, state, node)).preflight;
}

async function replayRestack(
  git: GitRepo,
  state: StackState,
  node: Pick<StatusJsonNode, "branch" | "parent">,
  rewrittenParent?: string,
): Promise<{ preflight: StatusPreflight; onto?: string }> {
  try {
    const parentSha = rewrittenParent ?? (await resolveOntoSha(git, state, node.parent));
    const branchSha = await git.getBranchTip(node.branch);
    const oldBase = await restackOldBase(git, state, node.branch, parentSha, branchSha);
    if (!oldBase) {
      return {
        preflight: {
          kind: "error",
          message: `No merge-base between ${node.parent} and ${node.branch}.`,
        },
      };
    }
    if (oldBase === parentSha) {
      return { preflight: { kind: "clean" }, onto: branchSha };
    }
    const commits = await git.getCommitsBetween(oldBase, branchSha);
    if (commits.length === 0) {
      return {
        preflight: { kind: "error", message: `No unique commits to restack for ${node.branch}.` },
      };
    }
    let ours = parentSha;
    let lastBase = oldBase;
    const files = new Set<string>();
    for (const commit of commits) {
      const result = await git.mergeTree({ mergeBase: lastBase, ours, theirs: commit.sha });
      for (const path of parseContentConflictPaths(`${result.stdout}\n${result.stderr}`)) {
        files.add(path);
      }
      if (files.size > 0) {
        return { preflight: { kind: "conflicts", files: [...files] } };
      }
      const tree = writtenTree(result.stdout);
      if (!tree) {
        const detail = result.stderr.trim() || result.stdout.trim();
        return {
          preflight: { kind: "error", message: detail || `merge-tree exited ${result.exitCode}.` },
        };
      }
      ours = await git.commitTree(tree, [ours], "ado-stack preflight");
      lastBase = commit.sha;
    }
    return { preflight: { kind: "clean" }, onto: ours };
  } catch (error) {
    return {
      preflight: { kind: "error", message: error instanceof Error ? error.message : String(error) },
    };
  }
}

async function restackOldBase(
  git: GitRepo,
  state: StackState,
  branch: string,
  parentSha: string,
  branchSha: string,
): Promise<string | undefined> {
  const recorded = state.branches[branch]?.lastRestackBase;
  if (recorded && (await git.isAncestor(recorded, branch))) {
    return recorded;
  }
  return git.mergeBase(parentSha, branchSha);
}

function writtenTree(stdout: string): string | undefined {
  const first = stdout.trim().split("\n")[0];
  return first !== undefined && /^[0-9a-f]{40,}$/i.test(first) ? first : undefined;
}
