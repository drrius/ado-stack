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

Pin a version with `ADO_STACK_VERSION=v0.1.0`. Override the install directory with `ADO_STACK_INSTALL_DIR`.

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

Run `ado-stack` with no arguments at a terminal to open the interactive UI. The home screen shows the stack forest with PR state, links, and the recommended next step. From there you can create a branch, submit with a preview, restack with a plan and guided conflict recovery, navigate the stack, initialize a repository, and log in with a hidden PAT prompt.

Scripts and CI keep the argv CLI. A bare `ado-stack` prints help when stdin or stdout is not a TTY. Pass `--no-tui` or set `ADO_STACK_NO_TUI=1` to opt out explicitly. Both surfaces run the same command implementations.

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
| `ado-stack status` | Show the stack forest, PR state, sync, and restack needs. |
| `ado-stack restack` | Rebase each layer onto its live parent, depth-first from each root. `--continue` / `--abort` after conflicts. |
| `ado-stack up` / `down` | Move to a child or the parent. `up` from a fork requires the child name. |
| `ado-stack checkout <ref>` | Check out a branch name or PR number. |
| `ado-stack auth` | Show, store, or clear credentials. |
| `ado-stack config` | Get or set `organization`, `project`, `repository`, `defaultBranch`, `branchPrefix`, `authMode`. |
| `ado-stack repair` | Rebuild local state when Git and Azure DevOps agree. Names cycles and parent disagreements; does not guess. |

`ado-stack --help` and `ado-stack --version` work on the compiled binary. Version comes from `package.json`.

## Safety

Restacks that rewrite a published branch use `git push --force-with-lease` only. Plain `--force` is not used.

Before rewriting, ado-stack checks that the branch is tracked and that the remote tip still matches the last tip it pushed. Unexpected remote commits abort the operation.

Conflicts stop immediately. Git rebase state is left in place. There is no automatic conflict resolution.

Uncommitted tracked changes block create, checkout, restack, and submit.

A stack branch checked out in another Git worktree blocks restack. The command names every held branch and its worktree, then rebases nothing. It does not move a held branch with plumbing.

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
