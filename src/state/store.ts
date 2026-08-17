import { mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CliError } from "../errors/cli-error.ts";
import { migrateState, type RestackPlanState, type StackState } from "./schema.ts";

export class StateStore {
  constructor(readonly gitDir: string) {}

  get directory(): string {
    return join(this.gitDir, "ado-stack");
  }

  get statePath(): string {
    return join(this.directory, "state.json");
  }

  get restackPlanPath(): string {
    return join(this.directory, "restack-in-progress.json");
  }

  async read(): Promise<StackState | undefined> {
    const file = Bun.file(this.statePath);
    if (!(await file.exists())) {
      return undefined;
    }
    const raw: unknown = await file.json();
    const parsed = migrateState(raw);
    if (!parsed.ok) {
      throw new CliError(
        `Could not read ${this.statePath}.\n\n${parsed.error}\n\nRun \`ado-stack init\` after inspecting Git and Azure DevOps, or delete the file if you intend to rebuild from remote metadata.`,
      );
    }
    return parsed.state;
  }

  async write(state: StackState): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await writeJsonAtomic(this.statePath, state);
  }

  async readRestackPlan(): Promise<RestackPlanState | undefined> {
    const file = Bun.file(this.restackPlanPath);
    if (!(await file.exists())) {
      return undefined;
    }
    return (await file.json()) as RestackPlanState;
  }

  async writeRestackPlan(plan: RestackPlanState): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await writeJsonAtomic(this.restackPlanPath, plan);
  }

  async clearRestackPlan(): Promise<void> {
    const file = Bun.file(this.restackPlanPath);
    if (await file.exists()) {
      await file.delete();
    }
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await Bun.write(temp, `${JSON.stringify(value, null, 2)}\n`);
  await renameFile(temp, path);
}

async function renameFile(from: string, to: string): Promise<void> {
  await rename(from, to);
}
