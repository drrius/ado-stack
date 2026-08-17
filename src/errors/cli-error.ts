export class CliError extends Error {
  readonly exitCode: number;
  readonly hint: string | undefined;

  constructor(
    message: string,
    options: { exitCode?: number; hint?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CliError";
    this.exitCode = options.exitCode ?? 1;
    this.hint = options.hint;
  }
}

export function isCliError(error: unknown): error is CliError {
  return error instanceof CliError;
}

export function formatError(error: unknown): string {
  if (isCliError(error)) {
    return error.hint ? `${error.message}\n\n${error.hint}` : error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
