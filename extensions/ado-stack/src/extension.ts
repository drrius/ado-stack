import * as vscode from "vscode";
import { AdoStackCliError, classifyCliFailure, runAdoStack } from "./cli";
import {
  type StatusJson,
  checkoutCandidates,
  childrenForUp,
  parseStatusJson,
  stackPosition,
} from "./model";
import { type StackTreeItem, StackTreeProvider } from "./tree";

export function activate(context: vscode.ExtensionContext): void {
  const tree = new StackTreeProvider();
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = "ado-stack.refresh";
  statusBar.name = "ado-stack";

  const refresh = async (): Promise<void> => {
    try {
      const model = await loadForest();
      tree.setModel(model);
      updateStatusBar(statusBar, model);
    } catch (error) {
      tree.setModel(undefined);
      statusBar.text = "ado-stack";
      statusBar.show();
      await showCliError(error);
    }
  };

  context.subscriptions.push(
    statusBar,
    vscode.window.registerTreeDataProvider("ado-stack.stack", tree),
    vscode.commands.registerCommand("ado-stack.refresh", refresh),
    vscode.commands.registerCommand(
      "ado-stack.checkout",
      async (target?: string | StackTreeItem) => {
        const fromTree = typeof target === "string" ? target : target?.node.branch;
        const branch = fromTree ?? (await pickCheckoutBranch());
        if (!branch) {
          return;
        }
        await runAndRefresh(["checkout", branch], refresh);
      },
    ),
    vscode.commands.registerCommand("ado-stack.restack", async () => {
      await runAndRefresh(["restack"], refresh);
    }),
    vscode.commands.registerCommand("ado-stack.submit", async () => {
      await runAndRefresh(["submit"], refresh);
    }),
    vscode.commands.registerCommand("ado-stack.up", async () => {
      const args = await upCommandArgs();
      if (!args) {
        return;
      }
      await runAndRefresh(args, refresh);
    }),
    vscode.commands.registerCommand("ado-stack.down", async () => {
      await runAndRefresh(["down"], refresh);
    }),
    vscode.commands.registerCommand("ado-stack.init", async () => {
      await runAndRefresh(["init"], refresh);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void refresh();
    }),
  );

  void refresh();
}

export function deactivate(): void {}

async function loadForest(): Promise<StatusJson> {
  const result = await runWorkspace(["status", "--json", "--preflight"]);
  if (result.exitCode !== 0) {
    throw classifyCliFailure(result);
  }
  return parseStatusJson(result.stdout);
}

async function runAndRefresh(args: string[], refresh: () => Promise<void>): Promise<void> {
  try {
    const result = await runWorkspace(args);
    if (result.exitCode !== 0) {
      throw classifyCliFailure(result);
    }
    await refresh();
  } catch (error) {
    await showCliError(error);
  }
}

async function pickCheckoutBranch(): Promise<string | undefined> {
  try {
    const model = await loadForest();
    const picked = await vscode.window.showQuickPick(
      checkoutCandidates(model).map((branch) => ({ label: branch })),
      { placeHolder: "Checkout branch" },
    );
    return picked?.label;
  } catch (error) {
    await showCliError(error);
    return undefined;
  }
}

async function upCommandArgs(): Promise<string[] | undefined> {
  try {
    const model = await loadForest();
    const children = childrenForUp(model);
    if (children.length <= 1) {
      return ["up"];
    }
    const picked = await vscode.window.showQuickPick(
      children.map((node) => ({
        label: node.branch,
        description: node.title ?? undefined,
      })),
      { placeHolder: "Move up to which child?" },
    );
    return picked ? ["up", picked.label] : undefined;
  } catch (error) {
    await showCliError(error);
    return undefined;
  }
}

async function runWorkspace(args: string[]) {
  const cwd = workspaceFolder();
  const command =
    vscode.workspace.getConfiguration("adoStack").get<string>("command") ?? "ado-stack";
  return runAdoStack({ command, args, cwd });
}

function workspaceFolder(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new AdoStackCliError("failed", "Open a folder to use ado-stack.");
  }
  return folder.uri.fsPath;
}

function updateStatusBar(statusBar: vscode.StatusBarItem, model: StatusJson): void {
  const position = stackPosition(model);
  const name = position.current?.branch ?? model.currentBranch;
  const where = position.total === 0 ? "empty" : `${position.index}/${position.total}`;
  statusBar.text = `ado-stack: ${name} ${where}`;
  statusBar.tooltip = `${model.currentBranch} in the stack`;
  statusBar.show();
}

async function showCliError(error: unknown): Promise<void> {
  if (error instanceof AdoStackCliError && error.kind === "missing-binary") {
    await vscode.window.showErrorMessage(error.message);
    return;
  }
  if (error instanceof AdoStackCliError && error.kind === "no-state") {
    const action = await vscode.window.showErrorMessage(error.message, "Run init");
    if (action === "Run init") {
      await vscode.commands.executeCommand("ado-stack.init");
    }
    return;
  }
  if (error instanceof AdoStackCliError && error.kind === "conflict") {
    await vscode.window.showErrorMessage(error.message);
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  await vscode.window.showErrorMessage(message);
}
