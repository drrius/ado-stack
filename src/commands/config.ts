import { type AppConfig, CONFIG_KEYS, isConfigKey, parseConfig } from "../config/schema.ts";
import { CliError } from "../errors/cli-error.ts";
import type { AppContext } from "./context.ts";

export async function configCommand(
  ctx: AppContext,
  args: string[],
  flags: Record<string, string | boolean>,
): Promise<number> {
  const sub = args[0] ?? "list";
  switch (sub) {
    case "list": {
      const global = await ctx.configStore.readGlobal();
      const repo = await ctx.configStore.readRepo();
      ctx.log.info("Resolved");
      for (const key of CONFIG_KEYS) {
        const resolved = resolvedValue(ctx, key);
        ctx.log.info(`  ${key}=${resolved ?? ""}`);
      }
      ctx.log.verbose(`global: ${JSON.stringify(global)}`);
      ctx.log.verbose(`repo: ${JSON.stringify(repo)}`);
      return 0;
    }
    case "get": {
      const key = args[1];
      if (!key || !isConfigKey(key)) {
        throw new CliError(`Usage: ado-stack config get <${CONFIG_KEYS.join("|")}>`);
      }
      const value = resolvedValue(ctx, key);
      if (value === undefined || value === "") {
        return 1;
      }
      ctx.log.info(value);
      return 0;
    }
    case "set": {
      const key = args[1];
      const raw = args[2];
      if (!key || raw === undefined || !isConfigKey(key)) {
        throw new CliError("Usage: ado-stack config set <key> <value> [--global]");
      }
      if (key === "authMode" && raw !== "auto" && raw !== "pat" && raw !== "azure-cli") {
        throw new CliError("authMode must be auto, pat, or azure-cli.");
      }
      const global = flags.global === true;
      const current = global
        ? await ctx.configStore.readGlobal()
        : await ctx.configStore.readRepo();
      const next: AppConfig = { ...parseConfig(current), [key]: raw, version: 1 };
      if (global) {
        await ctx.configStore.writeGlobal(next);
      } else {
        await ctx.configStore.writeRepo(next);
      }
      ctx.log.success(`Set ${key}=${raw} (${global ? "global" : "repository"}).`);
      return 0;
    }
    default:
      throw new CliError(`Unknown config command \`${sub}\`.\n\nUse list, get, or set.`);
  }
}

function resolvedValue(ctx: AppContext, key: (typeof CONFIG_KEYS)[number]): string | undefined {
  switch (key) {
    case "organization":
      return ctx.config.organization;
    case "project":
      return ctx.config.project;
    case "repository":
      return ctx.config.repository;
    case "defaultBranch":
      return ctx.config.defaultBranch;
    case "branchPrefix":
      return ctx.config.branchPrefix;
    case "authMode":
      return ctx.config.authMode;
    default: {
      const _exhaustive: never = key;
      return _exhaustive;
    }
  }
}
