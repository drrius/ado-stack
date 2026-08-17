import { describe, expect, test } from "bun:test";
import { redactHeaders, redactText } from "./redact.ts";

describe("credential redaction", () => {
  test("redacts bearer and basic headers", () => {
    expect(redactText("Authorization: Bearer abc.def.ghi")).toContain("[redacted]");
    expect(redactText("Authorization: Basic YTpi")).toContain("[redacted]");
  });

  test("redacts env assignments", () => {
    expect(redactText("AZURE_DEVOPS_EXT_PAT=supersecretvalue")).toBe(
      "AZURE_DEVOPS_EXT_PAT=[redacted]",
    );
  });

  test("redacts Authorization header values", () => {
    const headers = redactHeaders({ Authorization: "Basic abcdef", Accept: "application/json" });
    expect(headers.Authorization).toBe("[redacted]");
    expect(headers.Accept).toBe("application/json");
  });
});
