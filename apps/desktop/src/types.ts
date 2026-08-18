// Mirrors of the CLI's machine-readable output shapes. The CLI is the source
// of truth: src/commands/status-render.ts and src/commands/restack-events.ts.

export type PrState = "open" | "approved" | "rejected" | "completed" | "abandoned";

export type StatusJsonPullRequestStatus = "none" | "unknown" | PrState;

export type StatusPreflight =
  | { kind: "not-needed" }
  | { kind: "clean" }
  | { kind: "conflicts"; files: string[] }
  | { kind: "error"; message: string };

export type StatusJsonNode = {
  branch: string;
  parent: string;
  current: boolean;
  pullRequestNumber: number | null;
  pullRequestStatus: StatusJsonPullRequestStatus;
  title: string | null;
  url: string | null;
  needsRestack: boolean;
  diverged: boolean;
  ahead: number;
  behind: number;
  children: StatusJsonNode[];
  preflight?: StatusPreflight;
};

export type StatusJson = {
  defaultBranch: string;
  currentBranch: string;
  organization: string;
  project: string;
  repository: string;
  forest: StatusJsonNode[];
};

export type RestackStepStatus = "pending" | "in-progress" | "conflict" | "done";

export type RestackEvent =
  | { event: "plan"; steps: Array<{ branch: string; onto: string; status: RestackStepStatus }> }
  | { event: "up-to-date" }
  | { event: "step-start"; branch: string; onto: string }
  | { event: "step-done"; branch: string; onto: string }
  | {
      event: "conflict";
      branch: string;
      worktreePath: string;
      files: string[];
      blocked: string[];
      untouched: string[];
    }
  | { event: "done"; branches: string[] }
  | { event: "aborted" }
  | { event: "error"; message: string };

export type RestackStatusReport = {
  plan: {
    version: 1;
    steps: Array<{ branch: string; onto: string; status: RestackStepStatus }>;
  } | null;
  conflictBranch: string | null;
  rebase:
    | { inProgress: false }
    | { inProgress: true; worktreePath: string; conflictedFiles: string[] };
};

export type ProgramInfo = {
  name: string;
  path: string;
  source: "path" | "sidecar";
};

export type EnvInfo = {
  adoStack: ProgramInfo | null;
  git: ProgramInfo | null;
  agents: ProgramInfo[];
};

export type CaptureResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type AgentKind = "claude" | "codex";

export type LogLine = {
  stream: "stdout" | "stderr" | "app";
  line: string;
};
