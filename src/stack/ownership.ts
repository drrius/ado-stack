import type { GitCommit, GitRepo } from "../git/git.ts";
import type { StackBranchState } from "../state/schema.ts";

export type CommitRange = {
  fromExclusive: string;
  toInclusive: string;
  commits: GitCommit[];
};

export async function uniqueCommits(
  git: GitRepo,
  branch: string,
  record: StackBranchState,
): Promise<CommitRange> {
  const tip = await git.getBranchTip(branch);
  const commits = await git.getCommitsBetween(record.lastRestackBase, tip);
  return {
    fromExclusive: record.lastRestackBase,
    toInclusive: tip,
    commits,
  };
}

export function restackNeeded(options: {
  lastRestackBase: string;
  parentTip: string;
  parentCompleted: boolean;
}): boolean {
  return options.parentCompleted || options.lastRestackBase !== options.parentTip;
}
