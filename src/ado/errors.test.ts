import { describe, expect, test } from "bun:test";
import { adoErrorFromResponse, classifyHttpStatus, parseAdoErrorBody } from "./errors.ts";

describe("Azure DevOps error parsing", () => {
  test("reads message and typeKey", () => {
    const body = parseAdoErrorBody({
      message: "VS402335: The target branch does not exist",
      typeKey: "InvalidArgumentValueException",
      errorCode: 0,
    });
    expect(body.message).toContain("VS402335");
    expect(body.typeKey).toBe("InvalidArgumentValueException");
  });

  test("maps status codes", () => {
    expect(classifyHttpStatus(401)).toBe("unauthenticated");
    expect(classifyHttpStatus(403)).toBe("forbidden");
    expect(classifyHttpStatus(404)).toBe("not-found");
    expect(classifyHttpStatus(400)).toBe("bad-request");
    expect(classifyHttpStatus(503)).toBe("server");
  });

  test("turns 401 into an actionable CLI error", () => {
    const error = adoErrorFromResponse({
      status: 401,
      body: { message: "TF400813" },
      operation: "create pull request",
    });
    expect(error.message).toContain("ado-stack auth");
    expect(error.message).toContain("TF400813");
  });
});
