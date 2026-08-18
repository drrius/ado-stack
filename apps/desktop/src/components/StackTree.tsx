import { openUrl } from "@tauri-apps/plugin-opener";
import type { StatusJson, StatusJsonNode, StatusJsonPullRequestStatus } from "../types.ts";

function prBadge(status: StatusJsonPullRequestStatus, id: number | null): JSX.Element | null {
  if (status === "none") {
    return <span className="badge muted">no PR</span>;
  }
  const label = id !== null ? `PR ${id}` : "PR";
  const kind =
    status === "approved" || status === "completed"
      ? "good"
      : status === "rejected" || status === "abandoned"
        ? "bad"
        : "info";
  return (
    <span className={`badge ${kind}`}>
      {label}
      {status !== "unknown" ? ` · ${status}` : ""}
    </span>
  );
}

function preflightBadge(node: StatusJsonNode): JSX.Element | null {
  const preflight = node.preflight;
  if (!preflight || preflight.kind === "not-needed") {
    return null;
  }
  if (preflight.kind === "clean") {
    return <span className="badge good">restack: clean</span>;
  }
  if (preflight.kind === "conflicts") {
    return (
      <span className="badge bad" title={preflight.files.join("\n")}>
        restack conflicts: {preflight.files.length}
      </span>
    );
  }
  return (
    <span className="badge bad" title={preflight.message}>
      preflight error
    </span>
  );
}

function subtreeNeedsRestack(node: StatusJsonNode): boolean {
  return node.needsRestack || node.children.some(subtreeNeedsRestack);
}

type NodeProps = {
  node: StatusJsonNode;
  depth: number;
  onRestackStack?: (branch: string) => void;
  disabled?: boolean;
};

function Node({ node, depth, onRestackStack, disabled }: NodeProps): JSX.Element {
  return (
    <>
      <div className={`tree-row${node.current ? " current" : ""}`}>
        <span className="tree-indent" style={{ width: depth * 22 }} aria-hidden />
        <span className="tree-connector" aria-hidden>
          {depth > 0 ? "└─" : "├─"}
        </span>
        <span className="branch-name">{node.branch}</span>
        {node.current && <span className="badge current-badge">current</span>}
        {prBadge(node.pullRequestStatus, node.pullRequestNumber)}
        {node.needsRestack && <span className="badge warn-badge">needs restack</span>}
        {preflightBadge(node)}
        {node.diverged && <span className="badge warn-badge">diverged</span>}
        {(node.ahead > 0 || node.behind > 0) && (
          <span className="badge muted">
            {node.ahead > 0 ? `↑${node.ahead}` : ""}
            {node.behind > 0 ? `↓${node.behind}` : ""}
          </span>
        )}
        {depth === 0 && onRestackStack && subtreeNeedsRestack(node) && (
          <button
            type="button"
            className="link"
            disabled={disabled}
            title={`ado-stack restack --stack ${node.branch} — restacks only this tree`}
            onClick={() => onRestackStack(node.branch)}
          >
            restack ⟳
          </button>
        )}
        <span className="grow" />
        {node.title && <span className="pr-title">{node.title}</span>}
        {node.url && (
          <button
            type="button"
            className="link"
            onClick={() => {
              if (node.url) {
                void openUrl(node.url);
              }
            }}
          >
            open ↗
          </button>
        )}
      </div>
      {node.children.map((child) => (
        <Node
          key={child.branch}
          node={child}
          depth={depth + 1}
          onRestackStack={onRestackStack}
          disabled={disabled}
        />
      ))}
    </>
  );
}

type StackTreeProps = {
  status: StatusJson;
  onRestackStack?: (branch: string) => void;
  disabled?: boolean;
};

export function StackTree({ status, onRestackStack, disabled }: StackTreeProps): JSX.Element {
  // Real stacks first; single tracked branches (trees of height 1) are moved
  // into a collapsed group so they do not drown out the stacked work.
  const stacks = status.forest.filter((node) => node.children.length > 0);
  const standalone = status.forest.filter((node) => node.children.length === 0);
  return (
    <section className="card tree">
      <div className="tree-row trunk">
        <span className="branch-name">{status.defaultBranch}</span>
        <span className="badge muted">
          {status.organization}/{status.project}/{status.repository}
        </span>
      </div>
      {status.forest.length === 0 && (
        <div className="tree-row muted-text">No stack branches yet. Create one to get started.</div>
      )}
      {stacks.map((node) => (
        <Node
          key={node.branch}
          node={node}
          depth={0}
          onRestackStack={onRestackStack}
          disabled={disabled}
        />
      ))}
      {standalone.length > 0 && (
        <details className="standalone" open={stacks.length === 0}>
          <summary>
            Standalone branches ({standalone.length}) — tracked, but nothing is stacked on them
          </summary>
          {standalone.map((node) => (
            <Node
              key={node.branch}
              node={node}
              depth={0}
              onRestackStack={onRestackStack}
              disabled={disabled}
            />
          ))}
        </details>
      )}
    </section>
  );
}
