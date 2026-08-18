import { describe, expect, test } from "bun:test";
import type { RestackPlanState } from "../state/schema.ts";
import {
  conflictBranchOf,
  jsonRestackReporter,
  planEvent,
  serializeRestackEvent,
} from "./restack-events.ts";

const plan = (): RestackPlanState => ({
  version: 1,
  steps: [
    { branch: "A", onto: "main", ontoSha: "m2", oldBase: "m1", preRebaseTip: "a1", status: "done" },
    {
      branch: "B",
      onto: "A",
      ontoSha: "a1",
      oldBase: "a0",
      preRebaseTip: "b1",
      status: "conflict",
    },
    { branch: "C", onto: "B", ontoSha: "b1", oldBase: "b0", preRebaseTip: "c1", status: "pending" },
  ],
});

describe("restack events", () => {
  test("planEvent keeps only the fields tooling needs", () => {
    expect(planEvent(plan())).toEqual({
      event: "plan",
      steps: [
        { branch: "A", onto: "main", status: "done" },
        { branch: "B", onto: "A", status: "conflict" },
        { branch: "C", onto: "B", status: "pending" },
      ],
    });
  });

  test("each serialized event is a single JSON line", () => {
    const line = serializeRestackEvent({
      event: "conflict",
      branch: "B",
      worktreePath: "/tmp/repo",
      files: ["file.txt"],
      blocked: ["B", "C"],
      untouched: [],
    });
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toMatchObject({ event: "conflict", branch: "B" });
  });

  test("jsonRestackReporter emits one parseable line per lifecycle call", () => {
    const lines: string[] = [];
    const reporter = jsonRestackReporter((line) => lines.push(line));
    const [_, conflicted] = plan().steps;
    reporter.plan(plan());
    reporter.stepStart(conflicted!);
    reporter.stepDone(conflicted!);
    reporter.done(["A", "B", "C"]);
    reporter.upToDate();
    reporter.aborted();
    expect(lines.map((line) => (JSON.parse(line) as { event: string }).event)).toEqual([
      "plan",
      "step-start",
      "step-done",
      "done",
      "up-to-date",
      "aborted",
    ]);
    expect(JSON.parse(lines[1] ?? "")).toEqual({ event: "step-start", branch: "B", onto: "A" });
  });

  test("conflictBranchOf finds the stopped step", () => {
    expect(conflictBranchOf(plan())).toBe("B");
    expect(conflictBranchOf(null)).toBeNull();
    expect(conflictBranchOf({ version: 1, steps: [] })).toBeNull();
  });
});
