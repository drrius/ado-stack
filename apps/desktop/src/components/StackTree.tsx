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

function Node({ node, depth }: { node: StatusJsonNode; depth: number }): JSX.Element {
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
        <Node key={child.branch} node={child} depth={depth + 1} />
      ))}
    </>
  );
}

export function StackTree({ status }: { status: StatusJson }): JSX.Element {
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
      {status.forest.map((node) => (
        <Node key={node.branch} node={node} depth={0} />
      ))}
    </section>
  );
}
