import * as vscode from "vscode";
import type { StatusJson, StatusJsonNode } from "./model";

export class StackTreeProvider implements vscode.TreeDataProvider<StackTreeItem> {
  private readonly emitter = new vscode.EventEmitter<StackTreeItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private model: StatusJson | undefined;

  setModel(model: StatusJson | undefined): void {
    this.model = model;
    this.emitter.fire(undefined);
  }

  getTreeItem(element: StackTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: StackTreeItem): StackTreeItem[] {
    if (!this.model) {
      return [];
    }
    if (!element) {
      return [
        new StackTreeItem({
          branch: this.model.defaultBranch,
          parent: "",
          current: this.model.currentBranch === this.model.defaultBranch,
          pullRequestNumber: null,
          pullRequestStatus: "trunk",
          title: "trunk",
          url: null,
          needsRestack: false,
          diverged: false,
          ahead: 0,
          behind: 0,
          children: this.model.forest,
          preflight: { kind: "not-needed" },
        }),
      ];
    }
    return element.node.children.map((child) => new StackTreeItem(child));
  }
}

export class StackTreeItem extends vscode.TreeItem {
  constructor(readonly node: StatusJsonNode) {
    super(
      node.branch,
      node.children.length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );
    this.id = `${node.parent}/${node.branch}`;
    this.description = describeNode(node);
    this.tooltip = tooltipFor(node);
    this.iconPath = iconFor(node);
    this.contextValue = "ado-stack.branch";
    this.command = {
      command: "ado-stack.checkout",
      title: "Checkout",
      arguments: [node.branch],
    };
  }
}

function describeNode(node: StatusJsonNode): string {
  const parts: string[] = [];
  if (node.pullRequestNumber !== null) {
    parts.push(`#${node.pullRequestNumber}`);
  }
  if (node.preflight?.kind === "conflicts") {
    parts.push(`conflicts in ${node.preflight.files.length} files`);
  } else if (node.preflight?.kind === "clean") {
    parts.push("restacks clean");
  } else if (node.needsRestack) {
    parts.push("restack needed");
  } else if (node.pullRequestStatus === "open") {
    parts.push("synced");
  }
  if (node.current) {
    parts.push("current");
  }
  return parts.join(" · ");
}

function tooltipFor(node: StatusJsonNode): string {
  const lines = [node.branch];
  if (node.title) {
    lines.push(node.title);
  }
  if (node.preflight?.kind === "conflicts") {
    lines.push(`conflicts in ${node.preflight.files.length} files`);
    lines.push(...node.preflight.files);
  }
  return lines.join("\n");
}

function iconFor(node: StatusJsonNode): vscode.ThemeIcon {
  if (node.preflight?.kind === "conflicts") {
    return new vscode.ThemeIcon("warning");
  }
  if (node.needsRestack) {
    return new vscode.ThemeIcon("arrow-up");
  }
  if (node.diverged) {
    return new vscode.ThemeIcon("git-compare");
  }
  if (node.current) {
    return new vscode.ThemeIcon("circle-filled");
  }
  return new vscode.ThemeIcon("circle-outline");
}
