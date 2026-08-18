import { spawn } from "node:child_process";

export type CliResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type CliErrorKind = "missing-binary" | "no-state" | "conflict" | "failed";

export class AdoStackCliError extends Error {
  readonly kind: CliErrorKind;
  readonly result: CliResult | undefined;

  constructor(kind: CliErrorKind, message: string, result?: CliResult) {
    super(message);
    this.name = "AdoStackCliError";
    this.kind = kind;
    this.result = result;
  }
}

export async function runAdoStack(options: {
  command: string;
  args: string[];
  cwd: string;
}): Promise<CliResult> {
  try {
    return await spawnCommand(options.command, options.args, options.cwd);
  } catch (error) {
    if (isMissingBinary(error, options.command)) {
      throw new AdoStackCliError(
        "missing-binary",
        `ado-stack is not on the PATH (${options.command}). Install the CLI, then reload the window.`,
      );
    }
    throw error;
  }
}

export function classifyCliFailure(result: CliResult): AdoStackCliError {
  const text = `${result.stderr}\n${result.stdout}`;
  if (/No ado-stack state/i.test(text)) {
    return new AdoStackCliError(
      "no-state",
      "This repository has no ado-stack state. Run ado-stack init first.",
      result,
    );
  }
  if (/rebase/i.test(text) || /Git reported a conflict/i.test(text)) {
    return new AdoStackCliError(
      "conflict",
      `${cliMessage(result)}\n\nThe rebase was left in place. Resolve the conflicts in the editor, then run ado-stack restack --continue.`,
      result,
    );
  }
  return new AdoStackCliError("failed", cliMessage(result), result);
}

export function cliMessage(result: CliResult): string {
  return (
    result.stderr.trim() ||
    result.stdout.trim() ||
    `ado-stack exited ${result.exitCode}`
  ).trim();
}

function spawnCommand(command: string, args: string[], cwd: string): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

function isMissingBinary(error: unknown, command: string): boolean {
  if (!isErrno(error)) {
    return false;
  }
  return error.code === "ENOENT" || error.message.includes(command);
}

function isErrno(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
