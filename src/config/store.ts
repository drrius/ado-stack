import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CliError } from "../errors/cli-error.ts";
import { type AppConfig, parseConfig } from "./schema.ts";

export class ConfigStore {
  constructor(
    readonly globalDir: string,
    readonly gitDir?: string,
  ) {}

  get globalPath(): string {
    return join(this.globalDir, "config.json");
  }

  get repoPath(): string | undefined {
    return this.gitDir ? join(this.gitDir, "ado-stack", "config.json") : undefined;
  }

  async readGlobal(): Promise<AppConfig> {
    return readConfigFile(this.globalPath);
  }

  async readRepo(): Promise<AppConfig> {
    if (!this.repoPath) {
      return { version: 1 };
    }
    return readConfigFile(this.repoPath);
  }

  async writeGlobal(config: AppConfig): Promise<void> {
    await mkdir(this.globalDir, { recursive: true });
    await Bun.write(this.globalPath, `${JSON.stringify(config, null, 2)}\n`);
  }

  async writeRepo(config: AppConfig): Promise<void> {
    if (!this.repoPath) {
      throw new CliError("Not inside a Git repository.");
    }
    await mkdir(join(this.gitDir ?? "", "ado-stack"), { recursive: true });
    await Bun.write(this.repoPath, `${JSON.stringify(config, null, 2)}\n`);
  }
}

async function readConfigFile(path: string): Promise<AppConfig> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return { version: 1 };
  }
  return parseConfig(await file.json());
}
