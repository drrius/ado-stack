import { VERSION } from "../version.ts";
import {
  COMMAND_SPECS,
  type CommandGroup,
  type CommandName,
  type CommandSpec,
  booleanFlagNames,
  getCommandSpec,
  knownFlagNames,
} from "./commands.ts";

export type { CommandName } from "./commands.ts";

export type GlobalFlags = {
  help: boolean;
  version: boolean;
  verbose: boolean;
  debug: boolean;
  noTui: boolean;
  cwd: string;
};

export type ParsedCli =
  | { kind: "global-help"; flags: GlobalFlags }
  | { kind: "global-version"; flags: GlobalFlags }
  | {
      kind: "command";
      command: CommandSpec["name"];
      args: string[];
      flags: GlobalFlags;
      commandFlags: Record<string, string | boolean>;
    };

const COMMANDS: readonly CommandName[] = [
  ...COMMAND_SPECS.map((spec) => spec.name),
  "help",
  "version",
];

export function isCommandName(value: string): value is CommandName {
  return (COMMANDS as readonly string[]).includes(value);
}

export function parseArgv(argv: string[]): ParsedCli {
  const flags: GlobalFlags = {
    help: false,
    version: false,
    verbose: false,
    debug: false,
    noTui: false,
    cwd: process.cwd(),
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
      continue;
    }
    if (arg === "--version" || arg === "-V") {
      flags.version = true;
      continue;
    }
    if (arg === "--verbose" || arg === "-v") {
      flags.verbose = true;
      continue;
    }
    if (arg === "--debug") {
      flags.debug = true;
      continue;
    }
    if (arg === "--no-tui") {
      flags.noTui = true;
      continue;
    }
    if (arg === "--cwd") {
      const value = argv[++i];
      if (!value) {
        throw usageError("--cwd requires a path.");
      }
      flags.cwd = value;
      continue;
    }
    if (arg.startsWith("--cwd=")) {
      flags.cwd = arg.slice("--cwd=".length);
      continue;
    }
    rest.push(arg);
  }

  if (flags.version && rest.length === 0) {
    return { kind: "global-version", flags };
  }
  if ((flags.help && rest.length === 0) || rest.length === 0) {
    return { kind: "global-help", flags };
  }
  const [commandRaw, ...commandArgs] = rest;
  if (!commandRaw || !isCommandName(commandRaw)) {
    throw usageError(
      `Unknown command \`${commandRaw}\`.\n\nRun \`ado-stack --help\` for the list of commands.`,
    );
  }
  if (commandRaw === "help") {
    const helpTarget = commandArgs[0];
    if (helpTarget === undefined) {
      return { kind: "global-help", flags: { ...flags, help: true } };
    }
    const helpSpec = getCommandSpec(helpTarget);
    if (!helpSpec) {
      throw usageError(
        `Unknown command \`${helpTarget}\`.\n\nRun \`ado-stack --help\` for the list of commands.`,
      );
    }
    return {
      kind: "command",
      command: helpSpec.name,
      args: [],
      flags: { ...flags, help: true },
      commandFlags: { help: true },
    };
  }
  if (commandRaw === "version") {
    return { kind: "global-version", flags };
  }
  const command = getCommandSpec(commandRaw);
  if (!command) {
    throw usageError(`Unknown command \`${commandRaw}\`.`);
  }
  const { args, commandFlags } = splitCommandArgs(command.name, commandArgs);
  if (flags.help || commandFlags.help === true) {
    return {
      kind: "command",
      command: command.name,
      args,
      flags: { ...flags, help: true },
      commandFlags,
    };
  }
  return { kind: "command", command: command.name, args, flags, commandFlags };
}

function splitCommandArgs(
  command: CommandSpec["name"],
  argv: string[],
): { args: string[]; commandFlags: Record<string, string | boolean> } {
  const booleanNames = new Set(booleanFlagNames(command));
  const knownNames = new Set(knownFlagNames(command));
  const commandFlags: Record<string, string | boolean> = {};
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--help" || arg === "-h") {
      commandFlags.help = true;
      continue;
    }
    if (!arg.startsWith("-")) {
      args.push(arg);
      continue;
    }
    const [rawName, inline] = splitFlag(arg);
    const name = rawName.replace(/^--/, "");
    if (!knownNames.has(name)) {
      throw usageError(`Unknown option \`${rawName}\`.`);
    }
    if (booleanNames.has(name)) {
      if (inline !== undefined) {
        throw usageError(`Boolean option \`${rawName}\` does not accept a value.`);
      }
      commandFlags[name] = true;
      continue;
    }
    const value = inline ?? argv[++i];
    if (value === undefined) {
      throw usageError(`\`${arg}\` requires a value.`);
    }
    commandFlags[name] = value;
  }
  return { args, commandFlags };
}

function splitFlag(arg: string): [string, string | undefined] {
  const eq = arg.indexOf("=");
  if (eq === -1) {
    return [arg, undefined];
  }
  return [arg.slice(0, eq), arg.slice(eq + 1)];
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

function usageError(message: string): UsageError {
  return new UsageError(message);
}

export function printVersion(write: (line: string) => void = console.log): void {
  write(VERSION);
}

export function printHelp(write: (line: string) => void = console.log): void {
  const groups: Array<{ group: CommandGroup; title: string }> = [
    { group: "setup", title: "Setup" },
    { group: "daily", title: "Daily" },
    { group: "recovery", title: "Recovery" },
  ];
  const sections = groups.map(({ group, title }) => {
    const commands = COMMAND_SPECS.filter((spec) => spec.group === group)
      .map((spec) => `  ${spec.name.padEnd(12)} ${spec.summary}`)
      .join("\n");
    return `${title}:\n${commands}`;
  });
  write(`ado-stack ${VERSION}

Graphite-style stacked pull requests for Azure DevOps, using normal Git.

Usage:
  ado-stack <command> [options]

Workflow:
  auth login → init → create → submit

${sections.join("\n\n")}

Global options:
  --verbose            Extra progress
  --debug              Git commands and API URLs (tokens redacted)
  --cwd <path>         Run as if started in <path>
  --no-tui             Never launch the interactive UI
  -h, --help           Show help
  -V, --version        Show version

Run \`ado-stack <command> --help\` for command details.

Safety:
  History rewrites use git push --force-with-lease only.
  Dirty working trees are left untouched.
  Unknown remote commits are never overwritten.
`);
}

export function printCommandHelp(
  command: CommandSpec["name"],
  write: (line: string) => void = console.log,
): void {
  const spec = getCommandSpec(command);
  if (!spec) {
    throw new Error(`No help registered for ${command}`);
  }
  const usage = spec.usage.map((line) => `  ${line}`).join("\n");
  const options = spec.flags
    .map((flag) => {
      switch (flag.kind) {
        case "boolean":
          return `  --${flag.name}`;
        case "string":
          return `  --${flag.name} <${flag.valueName}>`;
        default: {
          const _exhaustive: never = flag;
          return _exhaustive;
        }
      }
    })
    .join("\n");
  write(`Usage:
${usage}

${spec.detail}

Options:
${options}`);
}
