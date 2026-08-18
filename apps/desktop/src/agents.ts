import type { AgentKind } from "./types.ts";

export type ConflictContext = {
  branch: string;
  worktreePath: string;
  files: string[];
};

/**
 * The agent's job is resolution only. Continuing the rebase, pushing, and
 * retargeting PRs stay with ado-stack, behind the human approval gate.
 */
export function buildConflictPrompt(context: ConflictContext): string {
  const files = context.files.map((file) => `- ${file}`).join("\n");
  return [
    `You are inside a Git worktree where a rebase of branch "${context.branch}" stopped with merge conflicts. Your only job is to resolve the conflicts and stage the resolved files.`,
    "",
    "Conflicted files:",
    files.length > 0 ? files : "- (run `git status` to list them)",
    "",
    "Instructions:",
    "1. Inspect each conflicted file and resolve every conflict marker (<<<<<<<, =======, >>>>>>>). Preserve the intent of BOTH sides: the commit being replayed and the new base it is being rebased onto. Read surrounding code as needed to produce a correct merge, not just a syntactic one.",
    "2. After resolving a file, stage it with `git add <path>`.",
    "3. Do NOT run `git rebase --continue`. Do NOT commit. Do NOT push. Do NOT edit files that have no conflicts.",
    "",
    "When every conflicted file is resolved and staged, stop and briefly summarize how you resolved each conflict.",
  ].join("\n");
}

export function agentCommand(kind: AgentKind, prompt: string): { program: string; args: string[] } {
  if (kind === "claude") {
    return {
      program: "claude",
      args: [
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "acceptEdits",
        "--allowedTools",
        "Read,Glob,Grep,LS,Edit,MultiEdit,Write,Bash(git add:*),Bash(git status:*),Bash(git diff:*),Bash(git log:*),Bash(git show:*)",
      ],
    };
  }
  return {
    program: "codex",
    args: ["exec", "--sandbox", "workspace-write", prompt],
  };
}

export function agentLabel(kind: AgentKind): string {
  return kind === "claude" ? "Claude Code" : "Codex";
}

type ClaudeStreamEvent = {
  type?: string;
  subtype?: string;
  result?: string;
  message?: {
    content?: Array<{
      type?: string;
      text?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
  };
};

/**
 * Turn one raw output line from an agent into displayable text, or null to
 * drop it. Claude Code emits `stream-json` lines; Codex emits plain text.
 */
export function renderAgentLine(kind: AgentKind, line: string): string | null {
  if (kind === "codex") {
    return line.length > 0 ? line : null;
  }
  let parsed: ClaudeStreamEvent;
  try {
    parsed = JSON.parse(line) as ClaudeStreamEvent;
  } catch {
    return line.length > 0 ? line : null;
  }
  if (parsed.type === "system") {
    return parsed.subtype === "init" ? "session started" : null;
  }
  if (parsed.type === "assistant") {
    const parts: string[] = [];
    for (const block of parsed.message?.content ?? []) {
      if (block.type === "text" && block.text) {
        parts.push(block.text);
      } else if (block.type === "tool_use" && block.name) {
        parts.push(`→ ${block.name} ${summarizeToolInput(block.name, block.input)}`);
      }
    }
    return parts.length > 0 ? parts.join("\n") : null;
  }
  if (parsed.type === "result") {
    const status = parsed.subtype === "success" ? "finished" : `finished (${parsed.subtype})`;
    return parsed.result ? `${status}: ${parsed.result}` : status;
  }
  return null;
}

function summarizeToolInput(name: string, input: Record<string, unknown> | undefined): string {
  if (!input) {
    return "";
  }
  if (name === "Bash" && typeof input.command === "string") {
    return input.command;
  }
  const path = input.file_path ?? input.path ?? input.pattern;
  return typeof path === "string" ? path : "";
}
