export type PullRequestStatus = "notSet" | "active" | "abandoned" | "completed";

export type AdoIdentity = {
  displayName?: string;
  uniqueName?: string;
  id?: string;
};

export type AdoRepository = {
  id: string;
  name: string;
  defaultBranch?: string;
  project?: { id?: string; name?: string };
};

export type AdoPullRequest = {
  pullRequestId: number;
  title: string;
  description?: string;
  status: PullRequestStatus;
  sourceRefName: string;
  targetRefName: string;
  isDraft?: boolean;
  createdBy?: AdoIdentity;
  reviewers?: Array<{ vote?: number; isRequired?: boolean; displayName?: string }>;
  mergeStatus?: string;
  lastMergeSourceCommit?: { commitId?: string };
};

export type CreatePullRequestInput = {
  sourceRefName: string;
  targetRefName: string;
  title: string;
  description?: string;
};

export type UpdatePullRequestInput = {
  title?: string;
  description?: string;
  targetRefName?: string;
  status?: PullRequestStatus;
};
