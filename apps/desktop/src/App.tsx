import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import { agentCommand, agentLabel, buildConflictPrompt, renderAgentLine } from "./agents.ts";
import { ConflictPanel, type ConflictState } from "./components/ConflictPanel.tsx";
import { LogPane } from "./components/LogPane.tsx";
import { StackTree } from "./components/StackTree.tsx";
import { type RunningJob, detectEnvironment, runCapture, startJob } from "./ipc.ts";
import type {
  AgentKind,
  EnvInfo,
  LogLine,
  RestackEvent,
  RestackStatusReport,
  StatusJson,
} from "./types.ts";

const REPO_KEY = "adoStack.repoPath";
const MAX_LOG = 800;

function tryParseRestackEvent(line: string): RestackEvent | null {
  if (!line.startsWith("{")) {
    return null;
  }
  try {
    const parsed = JSON.parse(line) as RestackEvent;
    return typeof parsed.event === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function describeEvent(event: RestackEvent): string {
  switch (event.event) {
    case "plan":
      return `plan: ${event.steps.map((step) => `${step.branch} → ${step.onto}`).join(", ")}`;
    case "up-to-date":
      return "Stack is already up to date.";
    case "step-start":
      return `restacking ${event.branch} onto ${event.onto}…`;
    case "step-done":
      return `✓ restacked ${event.branch} onto ${event.onto}`;
    case "conflict":
      return `✗ conflict on ${event.branch}: ${event.files.join(", ") || "(see worktree)"}`;
    case "done":
      return `✓ stack restacked: ${event.branches.join(", ")}`;
    case "aborted":
      return "Restack aborted. Branches already pushed were not rolled back.";
    case "error":
      return `error: ${event.message}`;
  }
}

export default function App() {
  const [repoPath, setRepoPath] = useState<string | null>(() => localStorage.getItem(REPO_KEY));
  const [env, setEnv] = useState<EnvInfo | null>(null);
  const [status, setStatus] = useState<StatusJson | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [needsInit, setNeedsInit] = useState(false);
  const [authText, setAuthText] = useState("");
  const [pat, setPat] = useState("");
  const [showLogin, setShowLogin] = useState(false);
  const [createName, setCreateName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [log, setLog] = useState<LogLine[]>([]);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const agentJob = useRef<RunningJob | null>(null);
  const conflictRef = useRef<ConflictState | null>(null);
  conflictRef.current = conflict;

  const appendLog = useCallback((line: LogLine) => {
    if (line.line.length === 0) {
      return;
    }
    setLog((existing) => [...existing.slice(-MAX_LOG), line]);
  }, []);

  const note = useCallback((text: string) => appendLog({ stream: "app", line: text }), [appendLog]);

  useEffect(() => {
    detectEnvironment()
      .then(setEnv)
      .catch((error: unknown) => note(`Could not inspect environment: ${String(error)}`));
  }, [note]);

  const refresh = useCallback(async () => {
    if (!repoPath) {
      return;
    }
    setLoading(true);
    try {
      const auth = await runCapture("ado-stack", ["auth", "status"], repoPath);
      setAuthText((auth.stdout || auth.stderr).trim().split("\n")[0] ?? "");
      const result = await runCapture("ado-stack", ["status", "--json", "--preflight"], repoPath);
      if (result.code === 0) {
        setStatus(JSON.parse(result.stdout) as StatusJson);
        setStatusError(null);
        setNeedsInit(false);
      } else {
        setStatus(null);
        setNeedsInit(result.stderr.includes("ado-stack init"));
        setStatusError(result.stderr.trim() || `ado-stack status exited ${result.code}`);
      }
      const planned = await runCapture("ado-stack", ["restack", "--status", "--json"], repoPath);
      if (planned.code === 0 && !conflictRef.current) {
        const report = JSON.parse(planned.stdout) as RestackStatusReport;
        if (report.conflictBranch && report.rebase.inProgress) {
          setConflict({
            branch: report.conflictBranch,
            worktreePath: report.rebase.worktreePath,
            files: report.rebase.conflictedFiles,
            phase: "choose",
            agentLog: [],
          });
        }
      }
    } catch (error) {
      setStatusError(String(error));
    } finally {
      setLoading(false);
    }
  }, [repoPath]);

  useEffect(() => {
    if (repoPath && env?.adoStack) {
      void refresh();
    }
  }, [repoPath, env, refresh]);

  const pickRepo = useCallback(async () => {
    const chosen = await open({
      directory: true,
      multiple: false,
      title: "Choose a Git repository",
    });
    if (typeof chosen === "string") {
      localStorage.setItem(REPO_KEY, chosen);
      setStatus(null);
      setStatusError(null);
      setConflict(null);
      setLog([]);
      setRepoPath(chosen);
    }
  }, []);

  /** Run a streaming ado-stack job in the repo, echoing output to the log. */
  const streamAdoStack = useCallback(
    async (label: string, args: string[]): Promise<number> => {
      if (!repoPath) {
        return -1;
      }
      setBusy(label);
      note(`$ ado-stack ${args.join(" ")}`);
      try {
        const job = await startJob({
          program: "ado-stack",
          args,
          cwd: repoPath,
          onLine: appendLog,
        });
        return await job.done;
      } catch (error) {
        note(`failed to start: ${String(error)}`);
        return -1;
      } finally {
        setBusy(null);
      }
    },
    [repoPath, appendLog, note],
  );

  /**
   * Run `ado-stack restack …` with --json, translating events into log lines.
   * Returns the conflict event if the run stopped on one.
   */
  const streamRestack = useCallback(
    async (args: string[]): Promise<Extract<RestackEvent, { event: "conflict" }> | null> => {
      if (!repoPath) {
        return null;
      }
      let conflictEvent: Extract<RestackEvent, { event: "conflict" }> | null = null;
      setBusy("restack");
      note(`$ ado-stack ${args.join(" ")}`);
      try {
        const job = await startJob({
          program: "ado-stack",
          args,
          cwd: repoPath,
          onLine: (line) => {
            if (line.stream === "stdout") {
              const event = tryParseRestackEvent(line.line);
              if (event) {
                note(describeEvent(event));
                if (event.event === "conflict") {
                  conflictEvent = event;
                }
                return;
              }
            }
            appendLog(line);
          },
        });
        await job.done;
      } catch (error) {
        note(`failed to start: ${String(error)}`);
      } finally {
        setBusy(null);
      }
      if (conflictEvent !== null) {
        const found = conflictEvent as Extract<RestackEvent, { event: "conflict" }>;
        setConflict({
          branch: found.branch,
          worktreePath: found.worktreePath,
          files: found.files,
          phase: "choose",
          agentLog: [],
        });
      }
      return conflictEvent;
    },
    [repoPath, appendLog, note],
  );

  const restack = useCallback(async () => {
    await streamRestack(["restack", "--json"]);
    await refresh();
  }, [streamRestack, refresh]);

  const restackStack = useCallback(
    async (branch: string) => {
      await streamRestack(["restack", "--stack", branch, "--json"]);
      await refresh();
    },
    [streamRestack, refresh],
  );

  const submit = useCallback(async () => {
    await streamAdoStack("submit", ["submit"]);
    await refresh();
  }, [streamAdoStack, refresh]);

  const initRepo = useCallback(async () => {
    await streamAdoStack("init", ["init"]);
    await refresh();
  }, [streamAdoStack, refresh]);

  const createBranch = useCallback(async () => {
    const name = createName.trim();
    if (!name || !repoPath) {
      return;
    }
    setBusy("create");
    try {
      const result = await runCapture("ado-stack", ["create", name], repoPath);
      note(result.code === 0 ? `✓ created ${name}` : result.stderr.trim());
      if (result.code === 0) {
        setCreateName("");
      }
    } finally {
      setBusy(null);
    }
    await refresh();
  }, [createName, repoPath, note, refresh]);

  const login = useCallback(async () => {
    if (!repoPath || pat.trim().length === 0) {
      return;
    }
    setBusy("login");
    try {
      const result = await runCapture("ado-stack", ["auth", "login"], repoPath, pat.trim());
      note(result.code === 0 ? "✓ PAT stored" : result.stderr.trim());
      if (result.code === 0) {
        setPat("");
        setShowLogin(false);
      }
    } finally {
      setBusy(null);
    }
    await refresh();
  }, [repoPath, pat, note, refresh]);

  const validateResolution = useCallback(async (current: ConflictState): Promise<ConflictState> => {
    const cwd = current.worktreePath;
    const unmerged = await runCapture("git", ["diff", "--name-only", "--diff-filter=U"], cwd);
    const remaining = unmerged.stdout.split("\n").filter((file) => file.length > 0);
    if (remaining.length > 0) {
      return {
        ...current,
        phase: "review",
        validation: { ok: false, message: `Still conflicted: ${remaining.join(", ")}` },
        diff: "",
      };
    }
    const markerTargets = current.files.length > 0 ? current.files : ["."];
    // Catches begin/end markers with or without a label, diff3 base markers,
    // and a leftover separator-only ======= line.
    const markers = await runCapture(
      "git",
      ["grep", "-nE", "^(<{7}( |$)|>{7}( |$)|\\|{7}( |$)|={7}$)", "--", ...markerTargets],
      cwd,
    );
    if (markers.code === 0 && markers.stdout.trim().length > 0) {
      return {
        ...current,
        phase: "review",
        validation: {
          ok: false,
          message: `Conflict markers are still present:\n${markers.stdout.trim()}`,
        },
        diff: "",
      };
    }
    // Everything must be staged: an unstaged edit would be invisible in the
    // reviewed diff and can derail the next rebase step.
    const porcelain = await runCapture("git", ["status", "--porcelain"], cwd);
    const entries = porcelain.stdout.split("\n").filter((line) => line.length > 0);
    const unstaged = entries
      .filter((line) => !line.startsWith("??") && line[1] !== " ")
      .map((line) => line.slice(3));
    if (unstaged.length > 0) {
      return {
        ...current,
        phase: "review",
        validation: {
          ok: false,
          message: `Unstaged changes in the worktree — stage or revert them first:\n${unstaged.join("\n")}`,
        },
        diff: "",
      };
    }
    const untracked = entries.filter((line) => line.startsWith("??")).map((line) => line.slice(3));
    const untrackedNote =
      untracked.length > 0
        ? `\n\nNote: untracked files were left in the worktree (they will NOT be committed): ${untracked.join(", ")}`
        : "";
    const diff = await runCapture("git", ["diff", "--cached"], cwd);
    return {
      ...current,
      phase: "review",
      validation: {
        ok: true,
        message: `No unresolved conflicts remain. Review the staged resolution below — it is everything that will be committed.${untrackedNote}`,
      },
      diff: diff.stdout,
    };
  }, []);

  const runAgent = useCallback(
    async (kind: AgentKind) => {
      const current = conflictRef.current;
      if (!current) {
        return;
      }
      const prompt = buildConflictPrompt({
        branch: current.branch,
        worktreePath: current.worktreePath,
        files: current.files,
      });
      const command = agentCommand(kind, prompt);
      setConflict({
        ...current,
        phase: "agent-running",
        agent: kind,
        agentLog: [],
        error: undefined,
      });
      let job: RunningJob;
      try {
        job = await startJob({
          program: command.program,
          args: command.args,
          cwd: current.worktreePath,
          onLine: (line) => {
            const rendered = renderAgentLine(kind, line.line);
            if (rendered) {
              setConflict((existing) =>
                existing ? { ...existing, agentLog: [...existing.agentLog, rendered] } : existing,
              );
            }
          },
        });
      } catch (error) {
        setConflict((existing) =>
          existing ? { ...existing, phase: "choose", error: String(error) } : existing,
        );
        return;
      }
      agentJob.current = job;
      const code = await job.done;
      agentJob.current = null;
      const after = conflictRef.current;
      if (!after) {
        return;
      }
      if (code !== 0) {
        setConflict({
          ...after,
          phase: "choose",
          error: `${agentLabel(kind)} exited with code ${code}. You can retry, use the other agent, or resolve manually.`,
        });
        return;
      }
      setConflict(await validateResolution(after));
    },
    [validateResolution],
  );

  const cancelAgent = useCallback(async () => {
    await agentJob.current?.kill();
  }, []);

  const validateManual = useCallback(async () => {
    const current = conflictRef.current;
    if (current) {
      setConflict(await validateResolution(current));
    }
  }, [validateResolution]);

  const approve = useCallback(async () => {
    const current = conflictRef.current;
    if (!current) {
      return;
    }
    setConflict({ ...current, phase: "continuing", error: undefined });
    // The index could have changed since the reviewed diff was produced;
    // re-validate so only the state the human just saw can be committed.
    const revalidated = await validateResolution(current);
    if (!revalidated.validation?.ok) {
      setConflict({
        ...revalidated,
        error: "The worktree changed since validation. Review the updated state before approving.",
      });
      return;
    }
    if (revalidated.diff !== current.diff) {
      setConflict({
        ...revalidated,
        error: "The staged changes are different from the diff you reviewed. Review again.",
      });
      return;
    }
    const rebase = await runCapture(
      "git",
      ["-c", "core.editor=true", "rebase", "--continue"],
      current.worktreePath,
    );
    if (rebase.code !== 0) {
      setConflict({
        ...current,
        phase: "review",
        error: `git rebase --continue failed:\n${(rebase.stderr || rebase.stdout).trim()}`,
      });
      return;
    }
    note(`✓ rebase continued on ${current.branch}`);
    setConflict(null);
    const next = await streamRestack(["restack", "--continue", "--json"]);
    if (!next) {
      note("Restack finished.");
    }
    await refresh();
  }, [note, streamRestack, refresh, validateResolution]);

  const abortRestack = useCallback(async () => {
    await streamRestack(["restack", "--abort", "--json"]);
    setConflict(null);
    await refresh();
  }, [streamRestack, refresh]);

  const missingCli = env !== null && env.adoStack === null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            ≡
          </span>
          ado-stack
        </div>
        <button type="button" className="ghost" onClick={pickRepo}>
          {repoPath ? repoPath : "Choose repository…"}
        </button>
        <div className="spacer" />
        {authText && (
          <button
            type="button"
            className="ghost small"
            onClick={() => setShowLogin((value) => !value)}
            title="Azure DevOps authentication"
          >
            {authText}
          </button>
        )}
        <button
          type="button"
          className="ghost"
          onClick={() => void refresh()}
          disabled={!repoPath || loading || busy !== null}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      {showLogin && (
        <section className="card login">
          <p>
            Paste an Azure DevOps personal access token (Code: Read &amp; Write). It is stored by
            the CLI in your user config directory, never in the repository.
          </p>
          <div className="row">
            <input
              type="password"
              value={pat}
              placeholder="Personal access token"
              onChange={(event) => setPat(event.target.value)}
            />
            <button
              type="button"
              onClick={() => void login()}
              disabled={busy !== null || pat.trim() === ""}
            >
              Log in
            </button>
          </div>
        </section>
      )}

      {missingCli && (
        <section className="card warn">
          <strong>ado-stack CLI not found.</strong> The app looked on PATH and next to the app
          binary. Install it with the command from the README, then restart the app.
        </section>
      )}

      {env && env.agents.length === 0 && (
        <section className="card subtle">
          No AI agent CLI detected. Install <code>claude</code> (Claude Code) or <code>codex</code>{" "}
          to enable AI conflict resolution. Manual resolution still works.
        </section>
      )}

      {!repoPath && (
        <section className="card empty-state">
          <h2>Open a repository</h2>
          <p>Choose a Git repository that uses Azure DevOps to see and manage its PR stack.</p>
          <button type="button" onClick={pickRepo}>
            Choose repository…
          </button>
        </section>
      )}

      {repoPath && conflict && (
        <ConflictPanel
          state={conflict}
          agents={env?.agents ?? []}
          onRunAgent={(kind) => void runAgent(kind)}
          onCancelAgent={() => void cancelAgent()}
          onValidateManual={() => void validateManual()}
          onApprove={() => void approve()}
          onAbort={() => void abortRestack()}
        />
      )}

      {repoPath && !conflict && (
        <main className="content">
          {needsInit && (
            <section className="card">
              <h2>Repository is not initialized</h2>
              <p>
                <code>ado-stack init</code> detects the Azure DevOps remote and writes local stack
                state. It does not change any branches.
              </p>
              <button type="button" onClick={() => void initRepo()} disabled={busy !== null}>
                Initialize
              </button>
            </section>
          )}
          {statusError && !needsInit && <section className="card warn pre">{statusError}</section>}
          {status && (
            <>
              <section className="actions">
                <div className="row">
                  <input
                    value={createName}
                    placeholder="new-branch-name"
                    onChange={(event) => setCreateName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        void createBranch();
                      }
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => void createBranch()}
                    disabled={busy !== null || createName.trim() === ""}
                  >
                    Create
                  </button>
                </div>
                <div className="spacer" />
                <button type="button" onClick={() => void submit()} disabled={busy !== null}>
                  {busy === "submit" ? "Submitting…" : "Submit stack"}
                </button>
                <button type="button" onClick={() => void restack()} disabled={busy !== null}>
                  {busy === "restack" ? "Restacking…" : "Restack"}
                </button>
              </section>
              <StackTree
                status={status}
                disabled={busy !== null}
                onRestackStack={(branch) => void restackStack(branch)}
              />
            </>
          )}
          <LogPane lines={log} />
        </main>
      )}
    </div>
  );
}
