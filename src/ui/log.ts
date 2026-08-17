import { redactText } from "./redact.ts";

export type LogLevel = "error" | "warn" | "info" | "verbose" | "debug";

export type Logger = {
  error: (message: string) => void;
  warn: (message: string) => void;
  info: (message: string) => void;
  success: (message: string) => void;
  verbose: (message: string) => void;
  debug: (message: string) => void;
};

export function createLogger(options: {
  verbose: boolean;
  debug: boolean;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}): Logger {
  const stdout = options.stdout ?? ((line) => console.log(line));
  const stderr = options.stderr ?? ((line) => console.error(line));
  const debugEnabled = options.debug;
  const verboseEnabled = options.verbose || debugEnabled;

  const write = (stream: (line: string) => void, message: string) => {
    stream(debugEnabled ? redactText(message) : message);
  };

  return {
    error: (message) => write(stderr, message),
    warn: (message) => write(stderr, message),
    info: (message) => write(stdout, message),
    success: (message) => write(stdout, `✓ ${message}`),
    verbose: (message) => {
      if (verboseEnabled) {
        write(stderr, message);
      }
    },
    debug: (message) => {
      if (debugEnabled) {
        write(stderr, `debug: ${redactText(message)}`);
      }
    },
  };
}
