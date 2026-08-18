---
name: ado-stack
description: Manage Graphite-style stacked pull requests in Azure DevOps with the ado-stack CLI. Use when creating, submitting, restacking, or repairing stacked branches/PRs in a repo whose remote is Azure DevOps (dev.azure.com), or when the user mentions ado-stack, stacked PRs on ADO, or restacking.
---

# ado-stack: stacked PRs on Azure DevOps

Drive the `ado-stack` CLI non-interactively. Prefer `--json` surfaces and parse them; never scrape human-readable output.

## Stack model

A stack is a forest of ordinary Git branches: each branch has one parent, the bottom branch's parent is trunk (e.g. `main`). `submit` opens one Azure DevOps PR per branch, each PR targeting its parent branch, so every PR shows only its own diff. When a lower PR merges, `restack` rebases the descendants onto the new base without replaying merged commits, then retargets their PRs.

## Detection and setup

Applies only inside a Git repo with an Azure DevOps remote (`dev.azure.com` / `visualstudio.com`). Check every remote, not just `origin` — the CLI itself accepts any remote and merely prefers `origin`: `git remote -v`.

Always disable the interactive UI first — a bare `ado-stack` at a TTY opens a TUI:

```bash
export ADO_STACK_NO_TUI=1   # or pass --no-tui per invocation
```

Then:

```bash
ado-stack auth status            # check credentials
ado-stack auth login             # PAT from ADO_STACK_PAT / AZURE_DEVOPS_EXT_PAT env, or piped on stdin
ado-stack init                   # detect the remote, write .git/ado-stack/state.json
```

Never pass a PAT as a command-line argument. Provide it via `ADO_STACK_PAT` or pipe it: `printf '%s' "$PAT" | ado-stack auth login`.

## Core loop

```bash
ado-stack create schema     # branch from HEAD, tracked as child of current stack position
# edit files, git add, git commit
ado-stack create api        # stacks on top of schema
# edit, commit
ado-stack submit            # pushes parent-before-child; opens/updates PRs targeting each parent
```

`create <name>` honors a configured `branchPrefix` (e.g. `alice/`). `submit` preserves existing PR titles and human description text; `--title <title>` sets the title for the current branch's PR.

## Reading state — parse JSON

```bash
ado-stack status --json                 # nested forest: branches, parents, PR id/state/url
ado-stack status --json --preflight     # adds per-branch restack prediction, preflight.kind =
                                        #   "not-needed" | "clean" | "conflicts" (with files[]) | "error"
ado-stack restack --status --json       # one object: { plan, conflictBranch, rebase }
                                        #   rebase: { inProgress: false } or
                                        #   { inProgress: true, worktreePath, conflictedFiles }
```

Run `status --json --preflight` before restacking to predict conflicts and which files they touch.

## Restacking

```bash
ado-stack restack --json                # whole forest
ado-stack restack --stack api --json    # only the tree containing `api` (root + descendants)
```

`--json` streams NDJSON on stdout, one object per line; human text goes to stderr. A conflict still exits non-zero after emitting its event.

Events: `plan` (ordered steps `{branch, onto, status}`), `up-to-date`, `step-start`, `step-done`, `conflict`, `done` (`{branches}`), `aborted`, `error` (`{message}`).

```json
{"event":"plan","steps":[{"branch":"api","onto":"main","status":"pending"},{"branch":"ui","onto":"api","status":"pending"}]}
{"event":"step-start","branch":"api","onto":"main"}
{"event":"conflict","branch":"api","worktreePath":"/repo","files":["src/api.ts"],"blocked":["api","ui"],"untouched":[]}
```

`blocked` is the subtree that cannot proceed; `untouched` lists branches never reached.

### Conflict recovery recipe

On a `conflict` event:

1. Work inside `worktreePath` from the event — the rebase may be running in a different worktree than the main checkout.
2. Resolve the conflict markers in each file listed in `files`.
3. `git add <file>` for each resolved file.
4. `git -c core.editor=true rebase --continue` in that worktree. A branch that replays several commits can conflict again here with **no new ado-stack event**: if this command fails, list the newly conflicted files with `git diff --name-only --diff-filter=U` and repeat steps 2–4 until the Git rebase completes.
5. Only after the Git rebase has finished, run `ado-stack restack --continue --json` **from the main repository checkout, not from `worktreePath`** — the restack plan lives in the main checkout's `.git`, and a linked worktree cannot see it (use `--cwd <main-checkout>` if needed). This resumes the plan and pushes.
6. Loop: another `conflict` event repeats these steps; stop on `done`.

If recovery is not possible, `ado-stack restack --abort` aborts the Git rebase and clears the plan. If context was lost mid-conflict, re-read `ado-stack restack --status --json` to find `conflictBranch`, `worktreePath`, and `conflictedFiles`.

## Housekeeping

```bash
ado-stack untrack <branch>   # stop managing a branch; Git branch and PR untouched.
                             # Refused if it has tracked children or a restack is in progress.
ado-stack repair             # rebuild state when Git and ADO PR targets agree; names conflicts, never guesses
ado-stack up [<child>]       # checkout child (name required at a fork)
ado-stack down               # checkout parent
ado-stack checkout <branch-or-pr-number>
```

## Safety rules

- Never `git push --force` a stack branch yourself. Only ado-stack pushes stack branches, and only with `--force-with-lease` plus a remote-tip check.
- Never rewrite history on branches you did not create; never rebase or amend stack branches with raw git — use `restack`.
- Do not "fix" broken state with destructive git commands (`reset --hard`, branch deletion, manual `rebase --abort` outside the recipe above). Use `ado-stack restack --abort`, `ado-stack repair`, or ask the user.
- Uncommitted changes to tracked files block `create`, `checkout`, `restack`, and `submit` — commit or stash those first. Untracked files are fine; do not stash or delete them. (A stack branch held by *another* worktree is stricter: that worktree must be fully clean before a restack will touch it.)
- Branch names may carry a configured `branchPrefix`. The short names printed by `status` are accepted by every branch-taking command (`create`, `checkout`, `up`, `restack --stack`, `untrack`).
- Never write a PAT to files, logs, command arguments, or PR descriptions.
