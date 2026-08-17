# Architecture

`ado-stack` is a local CLI. Git is the source of commits. Azure DevOps stores pull requests and a small namespaced property bag so another clone can rebuild the stack.

```text
CLI commands
  → stack graph + restack planner (pure)
  → git adapter (subprocess argv)
  → Azure DevOps HTTP client (fetch)
  → .git/ado-stack/state.json
```

## CLI layer

`src/cli/parse.ts` turns argv into a command and flags. `src/cli/run.ts` loads context and dispatches. Commands live in `src/commands/`. They do not shell out to Git themselves.

`--help` and `--version` do not require a Git repository. Other commands do, except `auth` and `config`.

## Interactive UI

`src/tui/session.ts` is a prompt loop built on `@clack/prompts`. A bare `ado-stack` at a TTY launches it. `src/tui/mode.ts` decides that from the parsed argv, `--no-tui`, `ADO_STACK_NO_TUI`, and both TTY flags; anything else stays on the argv CLI. Screens call the same functions in `src/commands/` through a logger whose sink is the prompt renderer, so the two surfaces cannot drift. The home screen consumes `loadStackStatus` from `src/commands/status.ts`; the `status` command renders the same model as plain text.

## Git layer

`src/git/git.ts` runs `git` with an argument array. Stdout and stderr are captured separately. Failures become `GitError` with the human-readable command.

History rewrites that must update a published branch call `forcePushWithLease`. There is no `--force` helper.

## Azure DevOps client

`src/ado/client.ts` talks to REST API 7.1.

It covers repository lookup, PR list/get/create/update, PR properties, pagination (`x-ms-continuationtoken`), and retries on 429/5xx.

Errors are decoded in `src/ado/errors.ts` so a missing target branch or a 401 is an actionable CLI message, not `Error 400`.

Auth headers are redacted in debug logs.

## State model

Machine-local state is `.git/ado-stack/state.json`, version 1.

Each tracked branch stores:

- `parent`
- `parentTipAtCreation`
- `lastRestackBase` (the parent SHA unique commits are measured against)
- `lastLocalTip`
- `lastKnownRemoteTip`
- `lastSubmittedTip`
- `pullRequestId`

`lastRestackBase..branch` is the commit range that belongs to that layer. Ancestry of `main` is not enough after a squash merge. See [restacking.md](restacking.md).

## Remote metadata

On submit, each PR gets properties:

- `ado-stack.version`
- `ado-stack.stack-id`
- `ado-stack.parent`
- `ado-stack.branch`
- `ado-stack.last-restack-base`

A managed markdown block between `<!-- ado-stack:start -->` and `<!-- ado-stack:end -->` is updated in the description. Human text outside that block is left alone.

Azure DevOps descriptions are limited to 4000 characters. List endpoints also truncate descriptions, so submit GETs the full PR before editing.

PR properties are the reconstruction source. Descriptions are for humans. If the properties API is unavailable in some organizations, `init` warns and leaves local state as the source of truth rather than parsing prose.

## Reconciliation

`init` and `repair` list PRs, read properties, and adopt a stack when every property-bearing PR shares one `stack-id` and forms a linear parent chain. Multiple stack IDs are reported, not guessed.

Local state is never trusted blindly. `status` compares Git tips, recorded SHAs, and PR source/target. Restack refuses to rewrite when the remote tip is not the last tip ado-stack pushed.

## Auth

`src/auth/credentials.ts` resolves a PAT or an Azure CLI bearer token. PATs are never written under the Git repository. Optional storage is the user config directory, mode 0600.

## Configuration

`src/config/` merges global config, repo config (`.git/ado-stack/config.json`), and environment variables. Secrets are not config keys.
