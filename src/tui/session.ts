import type { Readable, Writable } from "node:stream";
import { confirm, intro, isCancel, log, note, outro, password, select, text } from "@clack/prompts";
import pc from "picocolors";
import { parseAzureDevOpsRemote } from "../ado/remote.ts";
import { deleteStoredPat, resolveAuth, writeStoredPat } from "../auth/credentials.ts";
import {
  type AppContext,
  detectRemote,
  loadContext,
  requireState,
  resolveAdoAccess,
} from "../commands/context.ts";
import { createCommand } from "../commands/create.ts";
import { initCommand } from "../commands/init.ts";
import { checkoutCommand } from "../commands/navigate.ts";
import { previewRestack, restackCommand } from "../commands/restack.ts";
import { type NextStep, type StackStatus, loadStackStatus } from "../commands/status.ts";
import { submitCommand } from "../commands/submit.ts";
import { formatError } from "../errors/cli-error.ts";
import { stackOrder } from "../stack/graph.ts";
import { applyBranchPrefix, validateBranchName } from "../stack/names.ts";
import { RestackConflictError } from "../stack/restack.ts";
import { formatBranch, pullRequestWebUrl } from "../ui/format.ts";
import { createLogger } from "../ui/log.ts";
import { redactText } from "../ui/redact.ts";
import {
  type UpdateNotice,
  applyUpdate,
  checkForUpdate,
  formatUpdateNote,
  installHint,
  installKind,
} from "../update.ts";
import { VERSION } from "../version.ts";
import { renderStackLines } from "./render.ts";

export type TuiIo = { input?: Readable; output?: Writable };

type Session = { ctx: AppContext; io: TuiIo; update: UpdateNotice };

type HomeAction =
  | "navigate"
  | "create"
  | "submit"
  | "restack"
  | "auth"
  | "init"
  | "refresh"
  | "update"
  | "quit";

const ACTION_LABELS: Record<HomeAction, { label: string; hint?: string }> = {
  navigate: { label: "Navigate the stack", hint: "check out a branch" },
  create: { label: "Create a stack branch", hint: "on top of the current branch" },
  submit: { label: "Submit the stack", hint: "push and open or update PRs" },
  restack: { label: "Restack", hint: "rebase onto updated parents" },
  auth: { label: "Authentication", hint: "PAT status, login, logout" },
  init: { label: "Initialize", hint: "detect org, project, and repository" },
  refresh: { label: "Refresh", hint: "reload stack status" },
  update: { label: "Update ado-stack", hint: "install the latest release" },
  quit: { label: "Quit" },
};

export async function runTui(options: {
  cwd: string;
  io?: TuiIo;
  checkUpdate?: (configDir: string) => Promise<UpdateNotice>;
}): Promise<number> {
  const io: TuiIo = options.io ?? {};
  const print = (line: string) => log.message(line, { ...io });
  const logger = createLogger({ verbose: false, debug: false, stdout: print, stderr: print });
  const ctx = await loadContext({
    cwd: options.cwd,
    log: logger,
    verbose: false,
    debug: false,
    requireGit: false,
  });
  const update = await (options.checkUpdate ?? defaultCheckUpdate)(ctx.configDir);
  const session: Session = { ctx, io, update };
  const isRepo = await ctx.git.isRepository();
  intro(pc.inverse(` ado-stack ${VERSION} `), { ...io });
  const updateNote = formatUpdateNote(update);
  if (updateNote) {
    note(updateNote, "Update", { ...io });
  }
  while (true) {
    const action = await homeMenu(session, isRepo);
    if (action === "quit") {
      break;
    }
    const result = await dispatchAction(session, action);
    if (result === "exit") {
      break;
    }
  }
  outro("Done. `ado-stack --help` shows the scriptable CLI.", { ...io });
  return 0;
}

async function defaultCheckUpdate(configDir: string): Promise<UpdateNotice> {
  return checkForUpdate({ current: VERSION, configDir });
}

async function homeMenu(session: Session, isRepo: boolean): Promise<HomeAction> {
  if (!isRepo) {
    note(
      "This directory is not a Git repository.\nAuthentication works anywhere; the stack screens need a repository.",
      "ado-stack",
      { ...session.io },
    );
    return pickAction(session, withUpdate(["auth", "quit"], session.update), "auth");
  }
  const state = await session.ctx.stateStore.read();
  if (!state) {
    const remote = await detectRemote(session.ctx);
    const detected =
      remote && parseAzureDevOpsRemote(remote.url)
        ? `Detected Azure DevOps remote \`${remote.remoteName}\`: ${redactText(remote.url)}`
        : "No Azure DevOps remote detected. Initialize will ask for the details.";
    note(`No stack state in this repository yet.\n${detected}`, "Welcome", { ...session.io });
    return pickAction(session, withUpdate(["init", "auth", "quit"], session.update), "init");
  }
  let status: StackStatus;
  try {
    status = await loadStackStatus(session.ctx);
  } catch (error) {
    log.error(formatError(error), { ...session.io });
    return pickAction(
      session,
      withUpdate(["auth", "init", "refresh", "quit"], session.update),
      "refresh",
    );
  }
  note(renderStackLines(status, session.ctx.config.branchPrefix).join("\n"), "Stack", {
    ...session.io,
  });
  const actions = withUpdate(
    ["navigate", "create", "submit", "restack", "auth", "init", "refresh", "quit"],
    session.update,
  );
  const recommended = recommendedAction(status.next);
  return pickAction(session, actions, recommended ?? "navigate", recommended);
}

async function pickAction(
  session: Session,
  actions: HomeAction[],
  initial: HomeAction,
  recommended?: HomeAction,
): Promise<HomeAction> {
  const choice = await select<HomeAction>({
    message: "What next?",
    options: actions.map((action) => ({
      value: action,
      label: ACTION_LABELS[action].label,
      hint: actionHint(action, session.update, recommended),
    })),
    initialValue: initial,
    ...session.io,
  });
  if (isCancel(choice)) {
    return "quit";
  }
  return choice;
}

function actionHint(
  action: HomeAction,
  notice: UpdateNotice,
  recommended?: HomeAction,
): string | undefined {
  if (action === recommended) {
    return "recommended";
  }
  if (action === "update" && notice.kind === "available") {
    return `install ${notice.latest}`;
  }
  return ACTION_LABELS[action].hint;
}

function recommendedAction(next: NextStep): HomeAction | undefined {
  switch (next) {
    case "auth-login":
      return "auth";
    case "create":
      return "create";
    case "submit":
      return "submit";
    case "restack":
      return "restack";
    case "none":
      return undefined;
    default: {
      const _exhaustive: never = next;
      return _exhaustive;
    }
  }
}

async function dispatchAction(
  session: Session,
  action: Exclude<HomeAction, "quit">,
): Promise<"exit" | undefined> {
  switch (action) {
    case "navigate":
      await runFlow(session, flowNavigate);
      return;
    case "create":
      await runFlow(session, flowCreate);
      return;
    case "submit":
      await runFlow(session, flowSubmit);
      return;
    case "restack":
      await runFlow(session, flowRestack);
      return;
    case "auth":
      await runFlow(session, flowAuth);
      return;
    case "init":
      await runFlow(session, flowInit);
      return;
    case "update":
      try {
        return await flowUpdate(session);
      } catch (error) {
        log.error(formatError(error), { ...session.io });
        return undefined;
      }
    case "refresh":
      return;
    default: {
      const _exhaustive: never = action;
      throw new Error(`Unhandled action ${String(_exhaustive)}`);
    }
  }
}

async function runFlow(session: Session, flow: (session: Session) => Promise<void>): Promise<void> {
  try {
    await flow(session);
  } catch (error) {
    log.error(formatError(error), { ...session.io });
  }
}

async function flowUpdate(session: Session): Promise<"exit" | undefined> {
  const { io, update } = session;
  if (update.kind !== "available") {
    log.info("Already on the latest release.", { ...io });
    return;
  }
  if (installKind() === "source") {
    note(installHint(), `${update.latest} is available`, { ...io });
    return;
  }
  const ok = await confirm({
    message: `Install ${update.latest} over ${update.current}?`,
    ...io,
  });
  if (isCancel(ok) || !ok) {
    return;
  }
  const result = await applyUpdate({ destPath: process.execPath, version: update.latest });
  log.success(`Updated ${result.destPath} to ${result.latest}. Restart ado-stack to use it.`, {
    ...io,
  });
  return "exit";
}

function withUpdate(actions: HomeAction[], notice: UpdateNotice): HomeAction[] {
  if (notice.kind !== "available") {
    return actions;
  }
  return [...actions.filter((action) => action !== "quit"), "update", "quit"];
}

async function flowAuth(session: Session): Promise<void> {
  const { ctx, io } = session;
  const auth = await resolveAuth({ configDir: ctx.configDir, authMode: ctx.config.authMode });
  const current =
    auth.kind === "none"
      ? "Not authenticated."
      : `Authenticated via ${auth.kind} (${auth.source}).`;
  const choice = await select<"login" | "logout" | "back">({
    message: `Authentication: ${current}`,
    options: [
      { value: "login", label: "Log in", hint: "store a Personal Access Token" },
      { value: "logout", label: "Log out", hint: "delete the stored PAT" },
      { value: "back", label: "Back" },
    ],
    initialValue: auth.kind === "none" ? "login" : "back",
    ...io,
  });
  if (isCancel(choice) || choice === "back") {
    return;
  }
  if (choice === "logout") {
    await deleteStoredPat(ctx.configDir);
    log.success("Removed the stored PAT from the user config directory.", { ...io });
    return;
  }
  const pat = await password({
    message: "Azure DevOps Personal Access Token (input is hidden)",
    mask: "•",
    validate: (value) => ((value ?? "").trim().length === 0 ? "Enter a PAT." : undefined),
    ...io,
  });
  if (isCancel(pat)) {
    return;
  }
  await writeStoredPat(ctx.configDir, pat.trim());
  log.success(
    "Stored the PAT in the user config directory (mode 0600). It is not written to the repository.",
    { ...io },
  );
  const envPat =
    process.env.ADO_STACK_PAT ?? process.env.AZURE_DEVOPS_EXT_PAT ?? process.env.SYSTEM_ACCESSTOKEN;
  if (envPat) {
    log.warn("An environment PAT is set and takes precedence over the stored PAT.", { ...io });
  }
  await verifyStoredAuth(session);
}

async function verifyStoredAuth(session: Session): Promise<void> {
  const { ctx, io } = session;
  const state = await ctx.stateStore.read();
  if (!state) {
    return;
  }
  const access = await resolveAdoAccess(ctx, state);
  if (access.status === "unavailable") {
    log.warn(access.message, { ...io });
    return;
  }
  try {
    await access.client.getRepository();
    log.success(
      `Verified access to ${state.organizationName}/${state.project}/${state.repository}.`,
      { ...io },
    );
  } catch (error) {
    log.warn(`Could not verify the PAT against Azure DevOps: ${formatError(error)}`, { ...io });
  }
}

async function flowInit(session: Session): Promise<void> {
  const { ctx, io } = session;
  const remote = await detectRemote(ctx);
  const parsed = remote ? parseAzureDevOpsRemote(remote.url) : undefined;
  const remoteName = remote?.remoteName ?? ctx.config.remoteName;
  const existing = await ctx.stateStore.read();
  const organization = await askRequired(session, {
    message: "Organization URL",
    initialValue: existing?.organization ?? ctx.config.organization ?? parsed?.organizationUrl,
    placeholder: "https://dev.azure.com/<org>",
  });
  if (organization === undefined) {
    return;
  }
  const project = await askRequired(session, {
    message: "Project",
    initialValue: existing?.project ?? ctx.config.project ?? parsed?.project,
  });
  if (project === undefined) {
    return;
  }
  const repository = await askRequired(session, {
    message: "Repository",
    initialValue: existing?.repository ?? ctx.config.repository ?? parsed?.repository,
  });
  if (repository === undefined) {
    return;
  }
  const defaultBranch = await askRequired(session, {
    message: "Default branch",
    initialValue:
      existing?.defaultBranch ??
      ctx.config.defaultBranch ??
      (await ctx.git.defaultRemoteHead(remoteName)) ??
      "main",
  });
  if (defaultBranch === undefined) {
    return;
  }
  const ok = await confirm({
    message: `Initialize ${organization}/${project}/${repository} (default branch ${defaultBranch}, remote ${remoteName})?`,
    ...io,
  });
  if (isCancel(ok) || !ok) {
    return;
  }
  await initCommand(ctx, {
    organization,
    project,
    repository,
    "default-branch": defaultBranch,
    remote: remoteName,
  });
}

async function askRequired(
  session: Session,
  options: { message: string; initialValue?: string; placeholder?: string },
): Promise<string | undefined> {
  const value = await text({
    message: options.message,
    initialValue: options.initialValue,
    placeholder: options.placeholder,
    validate: (input) => ((input ?? "").trim().length === 0 ? "Required." : undefined),
    ...session.io,
  });
  if (isCancel(value)) {
    return undefined;
  }
  return value.trim();
}

async function flowCreate(session: Session): Promise<void> {
  const { ctx, io } = session;
  await requireState(ctx);
  const current = await ctx.git.currentBranch();
  if (!current) {
    log.error("HEAD is detached. Check out a stack branch or the default branch first.", {
      ...io,
    });
    return;
  }
  const prefix = ctx.config.branchPrefix;
  const name = await text({
    message: `Branch name (created on top of \`${formatBranch(current, prefix)}\`)`,
    placeholder: "my-change",
    validate: (value) => validateNameInput(value, prefix),
    ...io,
  });
  if (isCancel(name)) {
    return;
  }
  await createCommand(ctx, [name.trim()]);
}

function validateNameInput(value: string | undefined, prefix: string): string | undefined {
  const raw = (value ?? "").trim();
  if (raw.length === 0) {
    return "Enter a branch name.";
  }
  try {
    validateBranchName(applyBranchPrefix(raw, prefix));
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}

async function flowSubmit(session: Session): Promise<void> {
  const { ctx, io } = session;
  const state = await requireState(ctx);
  const order = stackOrder(state);
  if (order.length === 0) {
    log.info("The stack is empty. Create a branch first.", { ...io });
    return;
  }
  const prefix = ctx.config.branchPrefix;
  const lines = order.map((branch) => {
    const record = state.branches[branch];
    const action =
      record?.pullRequestId !== undefined
        ? `updates PR #${record.pullRequestId}`
        : "opens a new PR";
    return `${formatBranch(branch, prefix)} → ${formatBranch(record?.parent ?? state.defaultBranch, prefix)}  (${action})`;
  });
  note(
    lines.join("\n"),
    `Submit will push ${order.length} ${plural(order.length, "branch", "branches")}`,
    {
      ...io,
    },
  );
  const ok = await confirm({
    message: "Push the stack and create or update pull requests?",
    ...io,
  });
  if (isCancel(ok) || !ok) {
    return;
  }
  await submitCommand(ctx, {});
  const after = await ctx.stateStore.read();
  if (!after) {
    return;
  }
  const urls = stackOrder(after).flatMap((branch) => {
    const id = after.branches[branch]?.pullRequestId;
    return id === undefined ? [] : [`#${id}  ${pullRequestWebUrl(after, id)}`];
  });
  if (urls.length > 0) {
    note(urls.join("\n"), "Pull requests", { ...io });
  }
}

async function flowRestack(session: Session): Promise<void> {
  const { ctx, io } = session;
  if (await ctx.git.rebaseInProgress()) {
    log.warn("A Git rebase is in progress. Finish or abort it below.", { ...io });
    await conflictLoop(session);
    return;
  }
  const savedPlan = await ctx.stateStore.readRestackPlan();
  if (savedPlan) {
    note(
      "A previous restack left a saved plan. Continue it instead of starting a new one.",
      "Restack in progress",
      { ...io },
    );
    const choice = await select<"continue" | "abort" | "back">({
      message: "Resume restack?",
      options: [
        { value: "continue", label: "Continue restack", hint: "finish the saved plan" },
        { value: "abort", label: "Abort restack", hint: "clear the saved plan" },
        { value: "back", label: "Back to menu" },
      ],
      ...io,
    });
    if (isCancel(choice) || choice === "back") {
      return;
    }
    if (choice === "abort") {
      await restackCommand(ctx, { abort: true });
      return;
    }
    try {
      await restackCommand(ctx, { continue: true });
    } catch (error) {
      if (!(error instanceof RestackConflictError)) {
        throw error;
      }
      log.warn(`Rebase conflict on \`${error.branch}\`. Git state was left in place.`, { ...io });
      await conflictLoop(session);
    }
    return;
  }
  const plan = await previewRestack(ctx);
  if (plan.steps.length === 0) {
    log.info("Stack is already up to date.", { ...io });
    return;
  }
  const prefix = ctx.config.branchPrefix;
  const lines = plan.steps.map((step) => {
    const retarget = step.retargetPrTo
      ? `, then retarget its PR to ${formatBranch(step.retargetPrTo, prefix)}`
      : "";
    return `${formatBranch(step.branch, prefix)} → rebase onto ${formatBranch(step.onto, prefix)}${retarget}`;
  });
  note(lines.join("\n"), "Restack plan", { ...io });
  const ok = await confirm({
    message: `Rebase ${plan.steps.length} ${plural(plan.steps.length, "branch", "branches")} and push with --force-with-lease?`,
    ...io,
  });
  if (isCancel(ok) || !ok) {
    return;
  }
  try {
    await restackCommand(ctx, {});
  } catch (error) {
    if (!(error instanceof RestackConflictError)) {
      throw error;
    }
    log.warn(`Rebase conflict on \`${error.branch}\`. Git state was left in place.`, { ...io });
    await conflictLoop(session);
  }
}

async function conflictLoop(session: Session): Promise<void> {
  const { ctx, io } = session;
  while (true) {
    note(
      [
        "In your shell:",
        "  1. Resolve the conflicted files",
        "  2. git add <files>",
        "  3. git rebase --continue",
        "Then choose Continue here.",
      ].join("\n"),
      "Restack paused on a conflict",
      { ...io },
    );
    const choice = await select<"continue" | "abort" | "back">({
      message: "Restack recovery",
      options: [
        { value: "continue", label: "Continue restack", hint: "after git rebase --continue" },
        { value: "abort", label: "Abort restack", hint: "abort the rebase and clear the plan" },
        { value: "back", label: "Back to menu", hint: "leave the rebase paused" },
      ],
      ...io,
    });
    if (isCancel(choice) || choice === "back") {
      return;
    }
    if (choice === "abort") {
      await restackCommand(ctx, { abort: true });
      return;
    }
    try {
      await restackCommand(ctx, { continue: true });
      return;
    } catch (error) {
      if (error instanceof RestackConflictError) {
        log.warn(`Another conflict on \`${error.branch}\`.`, { ...io });
        continue;
      }
      log.error(formatError(error), { ...io });
    }
  }
}

async function flowNavigate(session: Session): Promise<void> {
  const { ctx, io } = session;
  const state = await requireState(ctx);
  const order = stackOrder(state);
  const current = await ctx.git.currentBranch();
  const prefix = ctx.config.branchPrefix;
  const branches = [state.defaultBranch, ...order];
  const target = await select<string>({
    message: "Check out",
    options: branches.map((branch) => ({
      value: branch,
      label:
        branch === state.defaultBranch
          ? `${formatBranch(branch, prefix)} (trunk)`
          : formatBranch(branch, prefix),
      hint: branchHint(state.branches[branch]?.pullRequestId, branch === current),
    })),
    initialValue: current !== undefined && branches.includes(current) ? current : undefined,
    ...io,
  });
  if (isCancel(target)) {
    return;
  }
  if (target === current) {
    log.info(`Already on ${formatBranch(target, prefix)}.`, { ...io });
    return;
  }
  await checkoutCommand(ctx, [target]);
}

function branchHint(pullRequestId: number | undefined, isCurrent: boolean): string | undefined {
  if (isCurrent) {
    return "current";
  }
  return pullRequestId === undefined ? undefined : `PR #${pullRequestId}`;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}
