import { authCommand } from "../commands/auth.ts";
import { configCommand } from "../commands/config.ts";
import { loadContext } from "../commands/context.ts";
import { createCommand } from "../commands/create.ts";
import { initCommand } from "../commands/init.ts";
import { checkoutCommand, downCommand, upCommand } from "../commands/navigate.ts";
import { repairCommand } from "../commands/repair.ts";
import { restackCommand } from "../commands/restack.ts";
import { statusCommand } from "../commands/status.ts";
import { submitCommand } from "../commands/submit.ts";
import { updateCommand } from "../commands/update.ts";
import { CliError, formatError, isCliError } from "../errors/cli-error.ts";
import { shouldLaunchTui } from "../tui/mode.ts";
import { runTui } from "../tui/session.ts";
import { type Logger, createLogger } from "../ui/log.ts";
import type { CommandSpec } from "./commands.ts";
import { UsageError, parseArgv, printCommandHelp, printHelp, printVersion } from "./parse.ts";

export async function run(argv: string[]): Promise<number> {
  let log: Logger | undefined;
  try {
    const parsed = parseArgv(argv);
    if (parsed.kind === "global-help") {
      if (
        shouldLaunchTui({
          parsed,
          env: process.env,
          stdinIsTty: Boolean(process.stdin.isTTY),
          stdoutIsTty: Boolean(process.stdout.isTTY),
        })
      ) {
        return await runTui({ cwd: parsed.flags.cwd });
      }
      printHelp();
      return 0;
    }
    if (parsed.kind === "global-version") {
      printVersion();
      return 0;
    }
    log = createLogger({ verbose: parsed.flags.verbose, debug: parsed.flags.debug });
    log.debug(`command=${parsed.command} args=${parsed.args.join(" ")}`);
    if (parsed.flags.help) {
      printCommandHelp(parsed.command);
      return 0;
    }
    const ctx = await loadContext({
      cwd: parsed.flags.cwd,
      log,
      verbose: parsed.flags.verbose,
      debug: parsed.flags.debug,
      requireGit:
        parsed.command !== "auth" && parsed.command !== "config" && parsed.command !== "update",
    });
    const exitCode = await dispatch(parsed.command, ctx, parsed.args, parsed.commandFlags);
    return exitCode ?? 0;
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      return 2;
    }
    const message = formatError(error);
    if (log) {
      log.error(message);
    } else {
      console.error(message);
    }
    if (isCliError(error)) {
      return error.exitCode;
    }
    return 1;
  }
}

async function dispatch(
  command: CommandSpec["name"],
  ctx: Awaited<ReturnType<typeof loadContext>>,
  args: string[],
  flags: Record<string, string | boolean>,
): Promise<number | undefined> {
  switch (command) {
    case "init":
      await initCommand(ctx, flags);
      return;
    case "create":
      await createCommand(ctx, args);
      return;
    case "submit":
      await submitCommand(ctx, flags);
      return;
    case "status":
      await statusCommand(ctx);
      return;
    case "restack":
      await restackCommand(ctx, flags);
      return;
    case "up":
      await upCommand(ctx, args);
      return;
    case "down":
      await downCommand(ctx);
      return;
    case "checkout":
      await checkoutCommand(ctx, args);
      return;
    case "auth":
      await authCommand(ctx, args);
      return;
    case "config":
      return configCommand(ctx, args, flags);
    case "repair":
      await repairCommand(ctx);
      return;
    case "update":
      await updateCommand(ctx);
      return;
    default: {
      const _exhaustive: never = command;
      throw new CliError(`Unhandled command ${String(_exhaustive)}`);
    }
  }
}
