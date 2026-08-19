import { isCI, isTTY, spinner } from "@clack/prompts";
import type { Writable } from "node:stream";

export type StepUpdate = (message: string) => void;

export type StepProgress = {
  interactive: boolean;
  run: <T>(label: string, work: (update: StepUpdate) => Promise<T>) => Promise<T>;
};

export function createStepProgress(options: { output?: Writable } = {}): StepProgress {
  const output = options.output ?? process.stdout;
  const interactive = isTTY(output) && !isCI();

  return {
    interactive,
    run: async (label, work) => {
      if (interactive) {
        const active = spinner({ output });
        active.start(label);
        try {
          const result = await work((message) => active.message(message));
          active.stop(label);
          return result;
        } catch (error) {
          active.error(label);
          throw error;
        }
      }

      const writeStep = (message: string) => {
        process.stderr.write(`${message}\n`);
      };
      writeStep(`${label}...`);
      try {
        const result = await work((message) => writeStep(`  ${message}`));
        writeStep(`✓ ${label}`);
        return result;
      } catch (error) {
        writeStep(`✗ ${label}`);
        throw error;
      }
    },
  };
}
