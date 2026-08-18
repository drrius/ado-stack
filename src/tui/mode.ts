import type { ParsedCli } from "../cli/parse.ts";

export function shouldLaunchTui(options: {
  parsed: ParsedCli;
  env: Record<string, string | undefined>;
  stdinIsTty: boolean;
  stdoutIsTty: boolean;
}): boolean {
  if (options.parsed.kind !== "global-help") {
    return false;
  }
  if (options.parsed.flags.help || options.parsed.flags.noTui) {
    return false;
  }
  const optOut = options.env.ADO_STACK_NO_TUI;
  if (optOut !== undefined && optOut !== "" && optOut !== "0") {
    return false;
  }
  return options.stdinIsTty && options.stdoutIsTty;
}
