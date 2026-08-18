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
  | "update"
  | "help"
  | "version";

export type FlagSpec =
  | { name: string; kind: "boolean" }
  | { name: string; kind: "string"; valueName: string };

export type CommandGroup = "setup" | "daily" | "recovery";

export type CommandSpec = {
  name: Exclude<CommandName, "help" | "version">;
  group: CommandGroup;
  summary: string;
  usage: string[];
  detail: string;
  positionals?: Array<{ name: string; required: boolean }>;
  flags: FlagSpec[];
};

export const COMMAND_SPECS: CommandSpec[] = [
  {
    name: "auth",
    group: "setup",
    summary: "Show, store, or clear Azure DevOps credentials",
    usage: ["ado-stack auth", "ado-stack auth login", "ado-stack auth logout"],
    detail:
      "Login reads a PAT from ADO_STACK_PAT or AZURE_DEVOPS_EXT_PAT, then prompts on a TTY or reads stdin. The PAT is stored in the user config directory with mode 0600, never in the repository.",
    positionals: [{ name: "action", required: false }],
    flags: [{ name: "help", kind: "boolean" }],
  },
  {
    name: "update",
    group: "setup",
    summary: "Install the latest ado-stack release",
    usage: ["ado-stack update"],
    detail:
      "Check GitHub Releases and replace the installed binary when a newer version exists. A TTY session also shows this notice on startup. From-source runs print the install command instead of overwriting the working tree.",
    flags: [{ name: "help", kind: "boolean" }],
  },
  {
    name: "init",
    group: "setup",
    summary: "Initialize or reconcile stack state for this repository",
    usage: [
      "ado-stack init [--organization <url>] [--project <name>] [--repository <name>] [--default-branch <name>] [--remote <name>]",
    ],
    detail:
      "Detect the Azure DevOps remote, write .git/ado-stack/state.json, and rebuild from pull request targets and metadata when parentage agrees. A parent with several children is a forest, not a conflict. Active pull requests that are not adopted are named with a reason.",
    flags: [
      { name: "organization", kind: "string", valueName: "url" },
      { name: "project", kind: "string", valueName: "name" },
      { name: "repository", kind: "string", valueName: "name" },
      { name: "default-branch", kind: "string", valueName: "name" },
      { name: "remote", kind: "string", valueName: "name" },
      { name: "help", kind: "boolean" },
    ],
  },
  {
    name: "config",
    group: "setup",
    summary: "Get or set configuration",
    usage: [
      "ado-stack config list",
      "ado-stack config get <key>",
      "ado-stack config set <key> <value> [--global]",
    ],
    detail:
      "Keys are organization, project, repository, defaultBranch, branchPrefix, and authMode.",
    positionals: [{ name: "action", required: false }],
    flags: [
      { name: "global", kind: "boolean" },
      { name: "help", kind: "boolean" },
    ],
  },
  {
    name: "create",
    group: "daily",
    summary: "Create a stack branch from the current branch",
    usage: ["ado-stack create <name>"],
    detail:
      "Create a Git branch from HEAD and record it in the stack. If the current branch already has children, the new branch is a sibling. Honors the configured branchPrefix.",
    positionals: [{ name: "name", required: true }],
    flags: [{ name: "help", kind: "boolean" }],
  },
  {
    name: "submit",
    group: "daily",
    summary: "Push the stack and create or update pull requests",
    usage: ["ado-stack submit [--title <title>]"],
    detail:
      "Push each stack branch and create or update its Azure DevOps pull request. Existing pull request titles and human description text are preserved.",
    flags: [
      { name: "title", kind: "string", valueName: "title" },
      { name: "help", kind: "boolean" },
    ],
  },
  {
    name: "status",
    group: "daily",
    summary: "Show local and Azure DevOps stack state",
    usage: ["ado-stack status"],
    detail:
      "Print the stack forest from trunk, pull request state, and whether restack is needed. Completed pull requests are absorbed before the forest is printed.",
    flags: [{ name: "help", kind: "boolean" }],
  },
  {
    name: "up",
    group: "daily",
    summary: "Check out a child stack branch",
    usage: ["ado-stack up", "ado-stack up <branch>"],
    detail:
      "Check out the child of the current stack branch. If the current branch has several children, pass the child name; ado-stack will not pick one.",
    positionals: [{ name: "branch", required: false }],
    flags: [{ name: "help", kind: "boolean" }],
  },
  {
    name: "down",
    group: "daily",
    summary: "Check out the parent stack branch",
    usage: ["ado-stack down"],
    detail: "Check out the parent of the current stack branch.",
    flags: [{ name: "help", kind: "boolean" }],
  },
  {
    name: "checkout",
    group: "daily",
    summary: "Check out a stack branch or pull request",
    usage: ["ado-stack checkout <branch-or-pr>"],
    detail: "Accept a branch name, prefixed name, or pull request number.",
    positionals: [{ name: "branch-or-pr", required: true }],
    flags: [{ name: "help", kind: "boolean" }],
  },
  {
    name: "restack",
    group: "recovery",
    summary: "Rebase stack branches onto updated parents and update submitted remotes",
    usage: ["ado-stack restack [--continue | --abort]"],
    detail:
      "Repair completed pull requests first, then rebase each remaining stack branch onto its live parent and update its remote. Branches that were never submitted are rebased locally only. A completed parent re-parents every child and retargets those pull requests before any rebase. Stops on conflicts and leaves Git rebase state in place. A branch held by another worktree is rebased there when that tree is clean. Dirty worktrees are named and refused before any rebase or push.",
    flags: [
      { name: "continue", kind: "boolean" },
      { name: "abort", kind: "boolean" },
      { name: "help", kind: "boolean" },
    ],
  },
  {
    name: "repair",
    group: "recovery",
    summary: "Rebuild local state from agreeing metadata",
    usage: ["ado-stack repair"],
    detail:
      "Rebuild local state when Git, Azure DevOps pull request targets, and recorded parents agree. A parent with several children is recorded. Cycles, missing parents, and parent disagreements are named and refused, not guessed.",
    flags: [{ name: "help", kind: "boolean" }],
  },
];

export function getCommandSpec(name: string): CommandSpec | undefined {
  return COMMAND_SPECS.find((spec) => spec.name === name);
}

export function booleanFlagNames(command: CommandSpec["name"]): string[] {
  return (
    getCommandSpec(command)
      ?.flags.filter((flag) => flag.kind === "boolean")
      .map((flag) => flag.name) ?? []
  );
}

export function knownFlagNames(command: CommandSpec["name"]): string[] {
  return getCommandSpec(command)?.flags.map((flag) => flag.name) ?? [];
}
