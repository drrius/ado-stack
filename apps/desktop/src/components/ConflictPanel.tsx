import { useEffect, useRef } from "react";
import { agentLabel } from "../agents.ts";
import type { AgentKind, ProgramInfo } from "../types.ts";

export type ConflictPhase = "choose" | "agent-running" | "review" | "continuing";

export type ConflictState = {
  branch: string;
  worktreePath: string;
  files: string[];
  phase: ConflictPhase;
  agent?: AgentKind;
  agentLog: string[];
  validation?: { ok: boolean; message: string };
  diff?: string;
  error?: string;
};

type Props = {
  state: ConflictState;
  agents: ProgramInfo[];
  onRunAgent: (kind: AgentKind) => void;
  onCancelAgent: () => void;
  onValidateManual: () => void;
  onApprove: () => void;
  onAbort: () => void;
};

export function ConflictPanel(props: Props): JSX.Element {
  const { state } = props;
  const logBottom = useRef<HTMLDivElement>(null);
  const agentLogCount = state.agentLog.length;
  useEffect(() => {
    if (agentLogCount > 0) {
      logBottom.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [agentLogCount]);

  const hasAgent = (kind: AgentKind) => props.agents.some((agent) => agent.name === kind);

  return (
    <main className="content conflict">
      <section className="card">
        <h2>
          Rebase conflict on <code>{state.branch}</code>
        </h2>
        <p className="muted-text">
          Worktree: <code>{state.worktreePath}</code>
        </p>
        {state.files.length > 0 && (
          <ul className="file-list">
            {state.files.map((file) => (
              <li key={file}>
                <code>{file}</code>
              </li>
            ))}
          </ul>
        )}
        {state.error && <div className="card warn pre">{state.error}</div>}

        {state.phase === "choose" && (
          <div className="conflict-actions">
            <div className="agent-buttons">
              <button
                type="button"
                onClick={() => props.onRunAgent("claude")}
                disabled={!hasAgent("claude")}
                title={
                  hasAgent("claude") ? "Resolve with Claude Code" : "claude was not found on PATH"
                }
              >
                Resolve with Claude Code
              </button>
              <button
                type="button"
                onClick={() => props.onRunAgent("codex")}
                disabled={!hasAgent("codex")}
                title={hasAgent("codex") ? "Resolve with Codex" : "codex was not found on PATH"}
              >
                Resolve with Codex
              </button>
            </div>
            <details className="manual">
              <summary>Resolve manually instead</summary>
              <ol>
                <li>Open the worktree above in your editor and resolve every conflict marker.</li>
                <li>
                  Stage each resolved file: <code>git add &lt;file&gt;</code>
                </li>
                <li>Come back and validate — the app will continue the rebase for you.</li>
              </ol>
              <button type="button" onClick={props.onValidateManual}>
                I resolved it — validate
              </button>
            </details>
            <div className="danger-zone">
              <button type="button" className="danger" onClick={props.onAbort}>
                Abort restack
              </button>
              <span className="muted-text">
                Leaves branches already pushed as they are; clears the plan.
              </span>
            </div>
          </div>
        )}

        {state.phase === "agent-running" && (
          <div className="agent-run">
            <div className="row">
              <span className="spinner" aria-hidden />
              <strong>{state.agent ? agentLabel(state.agent) : "Agent"}</strong>
              <span className="muted-text">
                resolving conflicts… it can read the worktree, edit conflicted files, and stage
                them. It cannot continue the rebase or push.
              </span>
              <span className="grow" />
              <button type="button" className="danger" onClick={props.onCancelAgent}>
                Cancel
              </button>
            </div>
            <div className="log-lines agent-log">
              {state.agentLog.map((line, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: append-only log
                <div key={index} className="log-line">
                  {line}
                </div>
              ))}
              <div ref={logBottom} />
            </div>
          </div>
        )}

        {state.phase === "review" && (
          <div className="review">
            <div className={`card ${state.validation?.ok ? "subtle" : "warn"} pre`}>
              {state.validation?.message ?? "Validation did not run."}
            </div>
            {state.validation?.ok && (
              <>
                <h3>Staged resolution</h3>
                <pre className="diff">{state.diff || "(no staged changes)"}</pre>
              </>
            )}
            <div className="row">
              {state.validation?.ok && (
                <button type="button" className="primary" onClick={props.onApprove}>
                  Approve — continue rebase
                </button>
              )}
              <button type="button" onClick={() => props.onRunAgent(state.agent ?? "claude")}>
                {state.agent ? `Re-run ${agentLabel(state.agent)}` : "Run agent"}
              </button>
              <button type="button" onClick={props.onValidateManual}>
                Re-validate
              </button>
              <span className="grow" />
              <button type="button" className="danger" onClick={props.onAbort}>
                Abort restack
              </button>
            </div>
          </div>
        )}

        {state.phase === "continuing" && (
          <div className="row">
            <span className="spinner" aria-hidden />
            Continuing the rebase and remaining restack steps…
          </div>
        )}
      </section>
    </main>
  );
}
