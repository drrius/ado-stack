import type { GitRepo } from "../git/git.ts";
import type { StackState } from "../state/schema.ts";

const GIT_SHA = /^[0-9a-f]{40}$/i;

export async function hydrateForestTips(git: GitRepo, state: StackState): Promise<StackState> {
  for (const [name, branch] of Object.entries(state.branches)) {
    if (!(await git.branchExists(name))) {
      continue;
    }
    branch.lastLocalTip = await git.getBranchTip(name);
    const parentRef =
      branch.parent === state.defaultBranch || (await git.branchExists(branch.parent))
        ? branch.parent
        : undefined;
    if (parentRef && !GIT_SHA.test(branch.lastRestackBase)) {
      const mergeBase = await git.mergeBase(parentRef, name);
      if (mergeBase) {
        branch.lastRestackBase = mergeBase;
      }
    }
    if ((await git.remoteBranchExists(state.remoteName, name)) && branch.lastKnownRemoteTip) {
      const actual = await git.getBranchTip(`${state.remoteName}/${name}`);
      if (actual === branch.lastLocalTip) {
        branch.lastKnownRemoteTip = actual;
      }
    }
  }
  return state;
}
