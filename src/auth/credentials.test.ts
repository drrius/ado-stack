import { describe, expect, test } from "bun:test";
import { resolveAuth } from "./credentials.ts";

describe("auth resolution", () => {
  test("prefers ADO_STACK_PAT", async () => {
    const auth = await resolveAuth({
      configDir: "/tmp/missing-ado-stack-config",
      authMode: "auto",
      env: { ADO_STACK_PAT: "pat-from-env" },
      azureCli: async () => "cli-token",
    });
    expect(auth).toMatchObject({ kind: "pat", source: "ADO_STACK_PAT" });
  });

  test("falls back to Azure CLI in auto mode", async () => {
    const auth = await resolveAuth({
      configDir: "/tmp/missing-ado-stack-config",
      authMode: "auto",
      env: {},
      azureCli: async () => "cli-token",
    });
    expect(auth).toMatchObject({ kind: "azure-cli", token: "cli-token" });
  });

  test("returns none when nothing is available", async () => {
    const auth = await resolveAuth({
      configDir: "/tmp/missing-ado-stack-config",
      authMode: "pat",
      env: {},
      azureCli: async () => {
        throw new Error("no az");
      },
    });
    expect(auth.kind).toBe("none");
  });
});
