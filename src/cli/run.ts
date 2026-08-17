import { authCommand } from "../commands/auth.ts";
import { checkoutCommand, downCommand, upCommand } from "../commands/navigate.ts";
import { configCommand } from "../commands/config.ts";
import { loadContext } from "../commands/context.ts";
import { createCommand } from "../commands/create.ts";
import { initCommand } from "../commands/init.ts";
import { repairCommand } from "../commands/repair.ts";
import { restackCommand } from "../commands/restack.ts";
import { statusCommand } from "../commands/status.ts";
import { submitCommand } from "../commands/submit.ts";
import { CliError, formatError, isCliError } from "../errors/cli-error.ts";
import { createLogger } from "../ui/log.ts";
import {
  type CommandName,
  parseArgv,
  printCommandHelp,
  printHelp,
  printVersion,
  UsageError,
} from "./parse.ts";

export async function run(argv: string[]): Promise<number> {
  try {
    const parsed = parseArgv(argv);
    if (parsed.kind === "global-help") {
      printHelp();
      return 0;
    }
    if (parsed.kind === "global-version") {
      printVersion();
      return 0;
    }
    const log = createLogger({ verbose: parsed.flags.verbose, debug: parsed.flags.debug });
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
      requireGit: parsed.command !== "auth" && parsed.command !== "config",
    });
    await dispatch(parsed.command, ctx, parsed.args, parsed.commandFlags);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      return 2;
    }
    console.error(formatError(error));
    if (isCliError(error)) {
      return error.exitCode;
    }
    return 1;
  }
}

async function dispatch(
  command: CommandName,
  ctx: Awaited<ReturnType<typeof loadContext>>,
  args: string[],
  flags: Record<string, string | boolean>,
): Promise<void> {
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
      await upCommand(ctx);
      return;
    case "down":
      await downCommand(ctx);
      return;
    case "checkout":
      await checkoutCommand(ctx, args);
      return;
    case "auth":
      await authCommand(ctx, args, flags);
      return;
    case "config":
      await configCommand(ctx, args, flags);
      return;
    case "repair":
      await repairCommand(ctx);
      return;
    case "help":
      printHelp();
      return;
    case "version":
      printVersion();
      return;
    default: {
      const _exhaustive: never = command;
      throw new CliError(`Unhandled command ${String(_exhaustive)}`);
    }
  }
}
