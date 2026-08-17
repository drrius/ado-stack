import { VERSION } from "../version.ts";

export type GlobalFlags = {
  help: boolean;
  version: boolean;
  verbose: boolean;
  debug: boolean;
  cwd: string;
};

export type ParsedCli =
  | { kind: "global-help"; flags: GlobalFlags }
  | { kind: "global-version"; flags: GlobalFlags }
  | {
      kind: "command";
      command: CommandName;
      args: string[];
      flags: GlobalFlags;
      commandFlags: Record<string, string | boolean>;
    };

export type CommandName =
  | "init"
  | "create"
  | "submit"
  | "status"
  | "restack"
  | "up"
  | "down"
  | "checkout"
  | "auth"
  | "config"
  | "repair"
  | "help"
  | "version";

const COMMANDS: readonly CommandName[] = [
  "init",
  "create",
  "submit",
  "status",
  "restack",
  "up",
  "down",
  "checkout",
  "auth",
  "config",
  "repair",
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
    return { kind: "global-help", flags };
  }
  if (commandRaw === "version") {
    return { kind: "global-version", flags };
  }
  const { args, commandFlags } = splitCommandArgs(commandRaw, commandArgs);
  if (flags.help || commandFlags.help === true) {
    return {
      kind: "command",
      command: commandRaw,
      args,
      flags: { ...flags, help: true },
      commandFlags,
    };
  }
  return { kind: "command", command: commandRaw, args, flags, commandFlags };
}

function splitCommandArgs(
  command: CommandName,
  argv: string[],
): { args: string[]; commandFlags: Record<string, string | boolean> } {
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
    if (booleanFlag(command, name)) {
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

function booleanFlag(command: CommandName, name: string): boolean {
  if (name === "continue" || name === "abort" || name === "global" || name === "help") {
    return true;
  }
  if (command === "auth" && (name === "pat" || name === "status")) {
    return true;
  }
  return false;
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
  write(`ado-stack ${VERSION}

Graphite-style stacked pull requests for Azure DevOps, using normal Git.

Usage:
  ado-stack <command> [options]

Commands:
  init                 Initialize or reconcile stack state for this repo
  create <name>        Create a new stack branch from the current branch
  submit               Push the stack and create or update Azure DevOps PRs
  status               Show local and Azure DevOps stack state
  restack              Rebase stack branches onto updated parents
  up                   Check out the child stack branch
  down                 Check out the parent stack branch
  checkout <ref>       Check out a stack branch or PR number
  auth                 Show, store, or clear credentials
  config               Get or set configuration
  repair               Rebuild unambiguous local state from Git and Azure DevOps

Global options:
  --verbose            Extra progress
  --debug              Git commands and API URLs (tokens redacted)
  --cwd <path>         Run as if started in <path>
  -h, --help           Show help
  -V, --version        Show version

Safety:
  History rewrites use git push --force-with-lease only.
  Dirty working trees are left untouched.
  Unknown remote commits are never overwritten.
`);
}

export function printCommandHelp(
  command: CommandName,
  write: (line: string) => void = console.log,
): void {
  switch (command) {
    case "init":
      write(`Usage: ado-stack init [--organization <url>] [--project <name>] [--repository <name>] [--default-branch <name>] [--remote <name>]

Detect the Azure DevOps remote, write .git/ado-stack/state.json, and rebuild from PR metadata when it is unambiguous.`);
      return;
    case "create":
      write(`Usage: ado-stack create <name>

Create a Git branch from HEAD and record it as the next layer of the linear stack. Honors config branchPrefix.`);
      return;
    case "submit":
      write(`Usage: ado-stack submit [--title <title>]

Push each stack branch and create or update the matching Azure DevOps pull request. Existing PR titles and human description text are preserved.`);
      return;
    case "status":
      write(`Usage: ado-stack status

Print the stack, PR state, and whether restack is needed. Exit 0 when the command itself succeeds.`);
      return;
    case "restack":
      write(`Usage: ado-stack restack [--continue | --abort]

Rebase each stack branch onto its live parent. After a squash merge, retarget the next active PR. Stops on conflicts and leaves Git rebase state in place.`);
      return;
    case "up":
      write(`Usage: ado-stack up

Check out the child of the current stack branch.`);
      return;
    case "down":
      write(`Usage: ado-stack down

Check out the parent of the current stack branch.`);
      return;
    case "checkout":
      write(`Usage: ado-stack checkout <branch-or-pr>

Accept a branch name, prefixed name, or pull request number.`);
      return;
    case "auth":
      write(`Usage:
  ado-stack auth
  ado-stack auth login
  ado-stack auth logout

login reads a PAT from ADO_STACK_PAT / AZURE_DEVOPS_EXT_PAT, or from stdin. The PAT is stored in the user config directory with mode 0600, never in the repo.`);
      return;
    case "config":
      write(`Usage:
  ado-stack config list
  ado-stack config get <key>
  ado-stack config set <key> <value> [--global]

Keys: organization, project, repository, defaultBranch, branchPrefix, authMode`);
      return;
    case "repair":
      write(`Usage: ado-stack repair

Rebuild local state when Git, Azure DevOps metadata, and recorded parents agree. Conflicting sources of truth are reported, not guessed.`);
      return;
    case "help":
      printHelp(write);
      return;
    case "version":
      printVersion(write);
      return;
    default: {
      const _exhaustive: never = command;
      throw new Error(`Unhandled help command ${String(_exhaustive)}`);
    }
  }
}
