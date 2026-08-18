import type { Logger } from "./log.ts";

export function logNext(log: Logger, message: string): void {
  log.info(`Next: ${message}`);
}
