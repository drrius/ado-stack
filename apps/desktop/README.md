# ado-stack desktop

A small Tauri desktop app over the `ado-stack` CLI. Same rule as the other UIs: the app is a renderer, the CLI stays the brain. Nothing in the app talks to Azure DevOps or rewrites Git history on its own — every action shells out to `ado-stack` (or `git` for read-only inspection), so the CLI's safety guarantees (`--force-with-lease` only, dirty trees refused, unknown remote commits never overwritten) apply unchanged.

## What it does

- **Stack forest** from `ado-stack status --json --preflight`: PR state, needs-restack and divergence badges, and per-branch conflict preflight (which files would conflict before you restack).
- **Actions**: init, create, submit, restack — with live streamed output.
- **Auth**: paste a PAT; it is piped to `ado-stack auth login` on stdin and stored by the CLI, never by the app.
- **AI conflict resolution**: when `ado-stack restack --json` stops on a conflict, resolve it with an agent already installed on your machine — Claude Code (`claude`) or Codex (`codex`) — or by hand.

### The conflict flow, exactly

1. `restack --json` emits a `conflict` event naming the branch, the worktree holding the rebase, and the conflicted files.
2. The chosen agent runs headless **in that worktree** with instructions to resolve the conflict markers and `git add` the files — and explicitly not to continue the rebase, commit, or push. Claude Code runs with `--permission-mode acceptEdits` and an allowlist of read/edit tools plus `git add`/`git status`/`git diff`; Codex runs `codex exec --sandbox workspace-write`.
3. The app validates: no unmerged paths remain and no conflict markers survive in the affected files.
4. **You review the staged diff and approve.** Only then does the app run `git rebase --continue` followed by `ado-stack restack --continue --json`, which pushes with lease and retargets PRs under the CLI's existing guards. If a later step conflicts, the flow loops.
5. Abort at any time with `restack --abort` semantics: Git rebase state is cleared, already-pushed branches are left as they are.

The agent binaries are discovered on `PATH` at startup. Neither is required — the manual path gives you the same validate → review → continue loop.

## Binary resolution

The app prefers `ado-stack` from your `PATH` (so the app and your terminal share one version and one state file), and falls back to the copy bundled with the app (a Tauri sidecar). Only four programs can ever be spawned — `ado-stack`, `git`, `claude`, `codex` — enforced in the Rust layer, not the webview.

## Development

Prereqs: Bun ≥ 1.3, Rust stable, and the [Tauri v2 system dependencies](https://v2.tauri.app/start/prerequisites/) for your OS.

```bash
cd apps/desktop
bun install
bun run sidecar      # compile the CLI into src-tauri/binaries for your platform
bun run tauri dev
```

`bun run build` typechecks and builds the frontend only. `bun run tauri build` produces installers (`.dmg`, `.msi`/NSIS, `.AppImage`, `.deb`) in `src-tauri/target/release/bundle/`.

Icons are generated, not hand-drawn: `bun run icons` rewrites `src-tauri/icons/` deterministically.

## Releases

`.github/workflows/desktop.yml` builds all four targets on a `desktop-v*` tag and attaches installers to a draft GitHub release. Builds are unsigned until signing credentials are configured: macOS users right-click → Open on first launch, Windows shows a SmartScreen prompt. To sign later, add the standard Tauri signing secrets to the workflow (Apple Developer ID + notarization, and a Windows certificate) — no code changes needed.
