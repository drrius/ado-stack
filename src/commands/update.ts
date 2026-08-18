import { CliError } from "../errors/cli-error.ts";
import {
  type HttpFetch,
  type InstallKind,
  applyUpdate,
  checkForUpdate,
  installHint,
  installKind,
} from "../update.ts";
import { VERSION } from "../version.ts";
import type { AppContext } from "./context.ts";

export async function updateCommand(
  ctx: Pick<AppContext, "configDir" | "log">,
  options: {
    fetch?: HttpFetch;
    destPath?: string;
    kind?: InstallKind;
    platform?: NodeJS.Platform;
    arch?: string;
  } = {},
): Promise<void> {
  const notice = await checkForUpdate({
    current: VERSION,
    configDir: ctx.configDir,
    fetch: options.fetch,
    force: true,
    timeoutMs: 15_000,
  });
  switch (notice.kind) {
    case "current":
      ctx.log.success(alreadyCurrentMessage(notice.current, options.kind ?? installKind()));
      return;
    case "unknown":
      throw new CliError("Could not check GitHub Releases for a newer ado-stack.", {
        hint: `Install manually:\n  ${installHint()}`,
      });
    case "available": {
      const kind = options.kind ?? installKind();
      if (kind === "source") {
        throw new CliError(
          `${notice.latest} is available. This session is running from source (${notice.current}).`,
          { hint: `Install a release binary:\n  ${installHint()}` },
        );
      }
      const result = await applyUpdate({
        destPath: options.destPath ?? process.execPath,
        version: notice.latest,
        fetch: options.fetch,
        platform: options.platform,
        arch: options.arch,
      });
      ctx.log.success(
        `Updated ${result.destPath} to ${result.latest}. Restart ado-stack to use it.`,
      );
      return;
    }
    default: {
      const _exhaustive: never = notice;
      throw _exhaustive;
    }
  }
}

function alreadyCurrentMessage(current: string, kind: InstallKind): string {
  return kind === "source" ? `Already on ${current} (from source).` : `Already on ${current}.`;
}
