import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { CaptureResult, EnvInfo } from "./types.ts";

export function detectEnvironment(): Promise<EnvInfo> {
  return invoke<EnvInfo>("detect_environment");
}

export function runCapture(
  program: string,
  args: string[],
  cwd: string,
  stdin?: string,
): Promise<CaptureResult> {
  return invoke<CaptureResult>("run_capture", { program, args, cwd, stdin: stdin ?? null });
}

export type StreamedLine = {
  stream: "stdout" | "stderr";
  line: string;
};

export type RunningJob = {
  done: Promise<number>;
  kill: () => Promise<void>;
};

type JobOutputPayload = { id: string; stream: "stdout" | "stderr"; line: string };
type JobExitPayload = { id: string; code: number };

let jobCounter = 0;

/**
 * Spawn an allowlisted program and stream its output line by line. The
 * returned promise resolves with the exit code after the last line arrived.
 */
export async function startJob(options: {
  program: string;
  args: string[];
  cwd: string;
  onLine: (line: StreamedLine) => void;
}): Promise<RunningJob> {
  jobCounter += 1;
  const id = `job-${Date.now()}-${jobCounter}`;
  let resolveDone: (code: number) => void;
  const done = new Promise<number>((resolve) => {
    resolveDone = resolve;
  });
  const unlistenOutput = await listen<JobOutputPayload>("job-output", (event) => {
    if (event.payload.id === id) {
      options.onLine({ stream: event.payload.stream, line: event.payload.line });
    }
  });
  const unlistenExit = await listen<JobExitPayload>("job-exit", (event) => {
    if (event.payload.id !== id) {
      return;
    }
    unlistenOutput();
    unlistenExit();
    resolveDone(event.payload.code);
  });
  try {
    await invoke("start_job", {
      id,
      program: options.program,
      args: options.args,
      cwd: options.cwd,
    });
  } catch (error) {
    unlistenOutput();
    unlistenExit();
    throw error;
  }
  return {
    done,
    kill: async () => {
      await invoke("kill_job", { id });
    },
  };
}
