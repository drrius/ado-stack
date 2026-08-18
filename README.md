# ado-stack

Graphite-style stacked pull requests for Azure DevOps.

Azure DevOps can target one PR at another branch. It does not give you a stacked workflow. `ado-stack` fills that gap with ordinary Git branches and Azure Repos pull requests.

```text
main
├── PR 1: schema
└── PR 2: API
    └── PR 3: UI
```

Smaller reviews land first. You keep building on top without waiting. Each PR shows only its own diff. When a lower PR squash-merges, `ado-stack restack` rebases the rest onto the new base without replaying the merged commits.

## Installation

```bash
curl -fsSL https://raw.githubusercontent.com/drrius/ado-stack/main/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/drrius/ado-stack/main/install.ps1 | iex
```

The installer downloads the latest GitHub Release for your OS (`ado-stack-darwin-arm64`, `ado-stack-darwin-x64`, `ado-stack-linux-x64`, or `ado-stack-windows-x64.exe`), checks SHA256, and installs into a user-writable directory (`~/.local/bin` or `%LOCALAPPDATA%\ado-stack\bin`).

`ado-stack update` does the same replacement later. A TTY session tells you when a newer release exists so you do not have to rerun the curl installer. Pin a version with `ADO_STACK_VERSION=v0.1.0`. Override the install directory with `ADO_STACK_INSTALL_DIR`.

### From source

Clone and run with Bun:

```bash
git clone https://github.com/drrius/ado-stack.git
cd ado-stack
bun install --frozen-lockfile
bun run src/index.ts --help
```

## Requirements

At runtime you need Git and Azure DevOps access. The compiled binary does not need Node or Bun.

## Quickstart

```bash
ado-stack auth login
ado-stack init

ado-stack create schema
# work + commit

ado-stack create api
# work + commit

ado-stack submit
```

`submit` pushes each branch and opens or updates PRs so `schema` targets `main` and `api` targets `schema`.

## Interactive UI

Run `ado-stack` with no arguments at a terminal to open the interactive UI. The home screen shows the stack forest with PR state, links, and the recommended next step. From there you can create a branch, submit with a preview, restack with a plan and guided conflict recovery, navigate the stack, initialize a repository, log in with a hidden PAT prompt, and install a newer release when one exists.

Scripts and CI keep the argv CLI. A bare `ado-stack` prints help when stdin or stdout is not a TTY. Pass `--no-tui` or set `ADO_STACK_NO_TUI=1` to opt out explicitly. Both surfaces run the same command implementations.

## Status views

After `init`, the same forest is available as terminal text, a local HTML graph, or a VS Code / Cursor sidebar. All three call the CLI. None of them talk to Azure DevOps on their own.

### Terminal

```bash
ado-stack status
ado-stack status --urls
ado-stack status --width 80
ado-stack status --json
ado-stack status --json --preflight
```

One branch is one line. Titles shrink to the terminal width (or 100 columns when the width is unknown). `--urls` adds the Azure DevOps link on that same line. `--json` prints only the nested forest, so you can pipe it. `--json` and `--web` cannot be combined.

### Local web graph

```bash
ado-stack status --web
```

That writes `.git/ado-stack/status.html`, prints the path, and tries to open it in your browser. The file is self-contained. No CDN, no server. Open the printed path yourself if the browser launcher fails, which is common on a headless host.

`--web` always runs a restack preflight. Each node shows whether a restack is needed and, when one would conflict, which files. The check replays each unique commit the way `restack` does, including children that would move because a parent is moving. It is a preview. It does not start a rebase.

`--json --preflight` attaches the same conflict data without writing HTML.

### VS Code and Cursor

The extension is a sidebar over the CLI, not a second stack client. `ado-stack` must be on your `PATH` (or set `adoStack.command` to an absolute path).

1. Install the CLI using the installer above, or run it from source with Bun.
2. In VS Code or Cursor, open the Command Palette and run **Extensions: Install from VSIX…**
3. Choose `extensions/ado-stack/ado-stack.vsix` from a clone of this repo.
4. Open the Git workspace you already initialized. Click the **ado-stack** icon in the activity bar.

Click a branch in the tree to check it out. The Command Palette also has Refresh, Restack, Submit, Up, Down, Init, and Checkout Branch. Checkout from the palette asks which branch. Up from a fork asks which child, the same rule as `ado-stack up`.

If the binary is missing, you get an error that names `adoStack.command`. If the repo has no state, the extension offers **Run init**. A restack that stops on a Git conflict tells you the rebase was left in place. An Azure DevOps HTTP conflict is just a failed submit. It is not a leftover rebase.

Rebuild the VSIX after changing the extension with `bun run extension:package`.

## Desktop app

`apps/desktop` is a Tauri app over the same CLI: the stack forest with PR state and conflict preflight, one-click init / create / submit / restack with streamed output, and PAT login (the token is piped to `ado-stack auth login`, stored by the CLI only). Trees of height one — tracked branches with nothing stacked on them — are grouped into a collapsed "standalone branches" section so real stacks stay readable, and each stack root has its own restack action (`restack --stack`).

When a restack stops on a conflict, the app can hand resolution to an AI agent already installed on your machine — Claude Code (`claude`) or Codex (`codex`), discovered on `PATH`. The agent runs headless in the worktree that holds the rebase and may only resolve conflict markers and `git add` the results. The app then validates that no conflicts or markers remain and shows you the staged diff; only after you approve does it run `git rebase --continue` and `ado-stack restack --continue`, so pushes and PR retargeting stay inside the CLI's safety rules. Manual resolution follows the same validate → review → continue loop, and both agents are optional.

The app prefers `ado-stack` from `PATH` and falls back to a bundled copy. Installers for macOS, Windows, and Linux are built by the `desktop` workflow on `desktop-v*` tags. See [apps/desktop/README.md](apps/desktop/README.md) for development and details.

## Workflow

```text
create → submit → review → merge parent → restack → repeat
```

If `schema` squash-merges into `main`, run `ado-stack restack`. The tool rebases `api` onto `main` using the commit range it recorded for `api`, then retargets the `api` PR. Parent commits are not replayed.

## Commands

| Command | What it does |
| --- | --- |
| `ado-stack init` | Detect the Azure Repos remote and write `.git/ado-stack/state.json`. Rebuilds from PR targets and metadata when parentage agrees. |
| `ado-stack create <name>` | Create a stack branch from `HEAD`. If `HEAD` already has children, the new branch is a sibling. Honors `branchPrefix`. |
| `ado-stack submit` | Push branches in parent-before-child order and create or update PRs. Writes namespaced PR properties and a managed description block. |
| `ado-stack status` | Show the stack forest, one line per branch. `--json` prints the same model. `--web` writes `.git/ado-stack/status.html`, runs a restack conflict preflight, and opens the file. See [Status views](#status-views). |
| `ado-stack restack` | Rebase each layer onto its live parent, depth-first from each root. `--stack <branch>` limits the run to the tree containing that branch, leaving other roots alone. `--continue` / `--abort` after conflicts. `--json` streams NDJSON events (plan, step-start, step-done, conflict with worktree path and files, done, aborted, error) for tooling; human messages move to stderr. `--status [--json]` reads the persisted plan and live rebase state without changing anything. |
| `ado-stack up` / `down` | Move to a child or the parent. `up` from a fork requires the child name. |
| `ado-stack checkout <ref>` | Check out a branch name or PR number. |
| `ado-stack auth` | Show, store, or clear credentials. |
| `ado-stack update` | Check GitHub Releases and replace the installed binary when a newer version exists. |
| `ado-stack config` | Get or set `organization`, `project`, `repository`, `defaultBranch`, `branchPrefix`, `authMode`. |
| `ado-stack repair` | Rebuild local state when Git and Azure DevOps agree. Names cycles and parent disagreements; does not guess. |
| `ado-stack untrack <branch>` | Stop managing a branch. The Git branch and any PR are left exactly as they are. Refused while it has tracked children or a restack is in progress. |

`ado-stack --help` and `ado-stack --version` work on the compiled binary. Version comes from `package.json`.

## Safety

Restacks that rewrite a published branch use `git push --force-with-lease` only. Plain `--force` is not used.

Before rewriting, ado-stack checks that the branch is tracked and that the remote tip still matches the last tip it pushed. Unexpected remote commits abort the operation.

Conflicts stop immediately. Git rebase state is left in place. There is no automatic conflict resolution.

Uncommitted tracked changes block create, checkout, restack, and submit.

A stack branch checked out in another Git worktree is rebased in that worktree when the tree is clean. A dirty holding worktree is named and blocks the whole restack.

## Authentication

Never put a PAT in the repo, stack metadata, logs, or PR descriptions.

Supported sources, in order for `authMode=auto`:

1. `ADO_STACK_PAT`
2. `AZURE_DEVOPS_EXT_PAT` (Azure CLI convention)
3. `SYSTEM_ACCESSTOKEN` (Azure Pipelines)
4. A `credentials.json` file in the user config directory (mode 0600), written by `ado-stack auth login`
5. `az account get-access-token` for Azure DevOps (`499b84ac-1321-427f-aa17-267ca6975798`)

`ado-stack auth login` reads the PAT from those environment variables first. Without one, it prompts for the PAT in a terminal or reads it from stdin when piped. Do not pass the token on the command line.

Debug logs redact `Authorization` headers, bearer tokens, and PAT-like values.

## Configuration

Repository settings live in `.git/ado-stack/config.json`. Global settings use the platform config directory (`~/.config/ado-stack` on Linux, `~/Library/Application Support/ado-stack` on macOS, `%APPDATA%\ado-stack` on Windows).

```bash
ado-stack config list
ado-stack config get branchPrefix
ado-stack config set branchPrefix darius/
```

No user name, organization, or Azure DevOps URL is hardcoded into commands.

## Limitations

Stacks are a forest of trees, not a DAG. A branch has one parent. It may have several children.

It does not support multiple parents, GitHub, GitLab, Bitbucket, merge queues, hosted services, telemetry, automatic conflict resolution, or deleting remote branches.

## Development

```bash
bun install --frozen-lockfile
bun run verify
```

`verify` runs lint, format check, typecheck, tests, compile, and a smoke test of `--help` / `--version` on the local binary.

## Live testing

Unit, real-Git, and fake-Azure-DevOps tests run in CI without credentials.

An optional live suite runs only when all of these are set:

```text
ADO_TEST_ORG
ADO_TEST_PROJECT
ADO_TEST_REPO
ADO_TEST_PAT
```

Create a disposable personal Azure DevOps organization:

1. Sign in at [https://dev.azure.com](https://dev.azure.com) with a personal Microsoft account.
2. Create a new organization. Use a throwaway name. Do not use a company org.
3. Create a project (private is fine) and an empty Git repo.
4. Create a PAT with Code (Read & Write) and Pull Request (Read & Write). Store it in `ADO_TEST_PAT`, never in the repo.
5. Clone that repo, `ado-stack init`, then walk through create / submit / merge / restack on throwaway branches such as `ado-stack-test/<timestamp>/schema`.

See [docs/architecture.md](docs/architecture.md) and [docs/restacking.md](docs/restacking.md) for how state and restack work.
