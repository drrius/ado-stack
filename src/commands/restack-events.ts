import type { RestackPlanState, RestackStep } from "../state/schema.ts";

export type RestackEvent =
  | { event: "plan"; steps: Array<{ branch: string; onto: string; status: RestackStep["status"] }> }
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

export type RestackReporter = {
  plan: (plan: RestackPlanState) => void;
  upToDate: () => void;
  stepStart: (step: RestackStep) => void;
  stepDone: (step: RestackStep) => void;
  done: (branches: string[]) => void;
  aborted: () => void;
};

export function serializeRestackEvent(event: RestackEvent): string {
  return JSON.stringify(event);
}

export function planEvent(plan: RestackPlanState): RestackEvent {
  return {
    event: "plan",
    steps: plan.steps.map((step) => ({
      branch: step.branch,
      onto: step.onto,
      status: step.status,
    })),
  };
}

export function jsonRestackReporter(write: (line: string) => void): RestackReporter {
  const emit = (event: RestackEvent) => write(serializeRestackEvent(event));
  return {
    plan: (plan) => emit(planEvent(plan)),
    upToDate: () => emit({ event: "up-to-date" }),
    stepStart: (step) => emit({ event: "step-start", branch: step.branch, onto: step.onto }),
    stepDone: (step) => emit({ event: "step-done", branch: step.branch, onto: step.onto }),
    done: (branches) => emit({ event: "done", branches: [...branches] }),
    aborted: () => emit({ event: "aborted" }),
  };
}

export type RestackStatusReport = {
  plan: RestackPlanState | null;
  conflictBranch: string | null;
  rebase:
    | { inProgress: false }
    | { inProgress: true; worktreePath: string; conflictedFiles: string[] };
};

export function conflictBranchOf(plan: RestackPlanState | null): string | null {
  const step = plan?.steps.find(
    (item) => item.status === "conflict" || item.status === "in-progress",
  );
  return step?.branch ?? null;
}
