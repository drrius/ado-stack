import type { AdoClient } from "../ado/client.ts";
import { targetBranchGoneMessage } from "../ado/errors.ts";
import {
  decodeStackProperties,
  encodeStackProperties,
  propertyPatches,
} from "../ado/properties.ts";
import { CliError } from "../errors/cli-error.ts";
import { stackOrder } from "../stack/graph.ts";
import type { PullRequestSnapshot } from "../stack/restack.ts";
import type { StackState } from "../state/schema.ts";
import { fromRefsHeads, refsHeads } from "./context.ts";

export type SnapshotLoad =
  | { ok: true; snapshots: Map<number, PullRequestSnapshot> }
  | { ok: false; pullRequestId: number; error: unknown };

export async function loadTrackedSnapshots(
  ado: AdoClient,
  state: StackState,
  only?: ReadonlySet<string>,
): Promise<SnapshotLoad> {
  const snapshots = new Map<number, PullRequestSnapshot>();
  for (const branch of stackOrder(state)) {
    if (only !== undefined && !only.has(branch)) {
      continue;
    }
    const id = state.branches[branch]?.pullRequestId;
    if (id === undefined) {
      continue;
    }
    try {
      const pr = await ado.getPullRequest(id);
      snapshots.set(id, {
        id,
        status: pr.status,
        sourceBranch: fromRefsHeads(pr.sourceRefName),
        targetBranch: fromRefsHeads(pr.targetRefName),
      });
    } catch (error) {
      return { ok: false, pullRequestId: id, error };
    }
  }
  return { ok: true, snapshots };
}

export function requireCompleteSnapshots(load: SnapshotLoad): Map<number, PullRequestSnapshot> {
  if (load.ok) {
    return load.snapshots;
  }
  throw new CliError(
    `Could not load PR #${load.pullRequestId} from Azure DevOps.\n\nComplete pull request state is required to handle merged parents safely.`,
    { cause: load.error },
  );
}

export async function retargetStackPullRequest(options: {
  ado: AdoClient;
  state: StackState;
  branch: string;
  pullRequestId: number;
  target: string;
}): Promise<boolean> {
  const pr = await options.ado.getPullRequest(options.pullRequestId);
  if (pr.status !== "active") {
    throw new CliError(
      `Cannot retarget PR #${pr.pullRequestId} because it is ${pr.status}. Expected an active PR from \`${options.branch}\`.`,
    );
  }
  if (fromRefsHeads(pr.sourceRefName) !== options.branch) {
    throw new CliError(
      `Cannot retarget PR #${pr.pullRequestId}: source is ${fromRefsHeads(pr.sourceRefName)}, expected ${options.branch}.`,
    );
  }
  if (fromRefsHeads(pr.targetRefName) === options.target) {
    return false;
  }
  try {
    await options.ado.updatePullRequest(pr.pullRequestId, {
      targetRefName: refsHeads(options.target),
    });
  } catch (error) {
    throw new CliError(targetBranchGoneMessage(options.target), { cause: error });
  }
  const record = options.state.branches[options.branch];
  const previous = await options.ado.getPullRequestProperties(pr.pullRequestId);
  const existing = decodeStackProperties(previous);
  const stackId = options.state.stackId ?? existing?.stackId;
  if (stackId && record) {
    await options.ado.updatePullRequestProperties(
      pr.pullRequestId,
      propertyPatches(
        encodeStackProperties({
          version: existing?.version ?? "1",
          stackId,
          parent: options.target,
          branch: options.branch,
          lastRestackBase: record.lastRestackBase,
        }),
        previous,
      ),
    );
  }
  return true;
}
