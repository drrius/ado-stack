import {
  deleteStoredPat,
  readStoredPat,
  resolveAuth,
  writeStoredPat,
} from "../auth/credentials.ts";
import { CliError } from "../errors/cli-error.ts";
import { logNext } from "../ui/next.ts";
import { readSecretLine } from "../ui/prompt.ts";
import type { AppContext } from "./context.ts";

export async function authCommand(ctx: AppContext, args: string[]): Promise<void> {
  const sub = args[0] ?? "status";
  switch (sub) {
    case "status":
      await showStatus(ctx);
      return;
    case "login":
      await login(ctx);
      return;
    case "logout":
      await deleteStoredPat(ctx.configDir);
      ctx.log.success("Removed the stored PAT from the user config directory.");
      return;
    default:
      throw new CliError(`Unknown auth command \`${sub}\`.\n\nUse status, login, or logout.`);
  }
}

async function showStatus(ctx: AppContext): Promise<void> {
  const auth = await resolveAuth({
    configDir: ctx.configDir,
    authMode: ctx.config.authMode,
  });
  if (auth.kind === "none") {
    ctx.log.info("Not authenticated.");
    logNext(ctx.log, "ado-stack auth login");
    return;
  }
  ctx.log.info(`Authenticated via ${auth.kind} (${auth.source}).`);
}

async function login(ctx: AppContext): Promise<void> {
  const fromEnv = process.env.ADO_STACK_PAT ?? process.env.AZURE_DEVOPS_EXT_PAT;
  let pat = fromEnv;
  if (!pat && process.stdin.isTTY) {
    pat = (await readSecretLine("PAT: ")).trim();
  } else if (!pat) {
    pat = (await Bun.stdin.text()).trim();
  }
  if (!pat) {
    throw new CliError(
      "No PAT provided.\n\nPipe the token on stdin, set AZURE_DEVOPS_EXT_PAT, or export ADO_STACK_PAT before `ado-stack auth login`.\nDo not pass the PAT on the command line.",
    );
  }
  await writeStoredPat(ctx.configDir, pat);
  const stored = await readStoredPat(ctx.configDir);
  if (!stored) {
    throw new CliError("Failed to store the PAT.");
  }
  ctx.log.success(
    "Stored PAT in the user config directory (mode 0600). It is not written to the repository.",
  );
}
