# Restacking

ado-stack tracks **commit ownership per layer** with an explicit base SHA. It does not infer a layer from current ancestry of `main`.

## Recorded boundaries

When `B` is created from `A`, state stores `B.lastRestackBase = tip(A)` at that moment. Unique commits for `B` are:

```text
git log --reverse B.lastRestackBase..B
```

The same field is updated after a successful restack onto a new parent tip.

`parentTipAtCreation` is the original parent SHA. Restack uses `lastRestackBase`, which moves forward as the stack is rewritten.

## Worked example

Start:

```text
main: M
A:    M-A1-A2
B:    M-A1-A2-B1-B2
C:    M-A1-A2-B1-B2-C1
```

Recorded bases:

```text
A.lastRestackBase = M
B.lastRestackBase = A2
C.lastRestackBase = B2
```

Unique ranges:

```text
A: A1 A2
B: B1 B2
C: C1
```

## Parent gets new commits

`A` becomes `M-A1-A2-A3`. Restack rebases `B` with:

```text
git rebase --onto A3 A2 B
```

Then rebases `C` with:

```text
git rebase --onto B' B2 C
```

`B'` is the rewritten `B`. `C` still uses old `B2` as `oldBase` until that rebase runs. The child's base is not rewritten when the parent is restacked. Doing that would mix parent commits into the child's range.

## Parent is rebased

Same operation. `oldBase` is still the recorded parent tip, not "whatever `main` currently is".

## Completed merge

Azure DevOps marks a stacked PR completed. Detection is that PR status, not the commit shape. `status`, `init`, `repair`, and `restack` all run the same absorption before any rebase. The user does not run a separate repair command.

A completed parent with several children re-parents every direct child onto the living base. That base is the completed PR's target, then any further completed targets until a living branch. A stale local parent is ignored. A source that does not match the tracked branch, a target that is not trunk or tracked, or a target that is a descendant is refused and named. Grandchildren keep their own parents. Each child's PR is retargeted to the new base when it is not already there. The merged row is dropped from `state.json` immediately, then written, so a crash mid-forest does not leave a missing parent.

`init` and `repair` absorb only after a successful reconstruct. A refused rebuild leaves `state.json` unchanged. `status` skips absorption and still prints local rows when a tracked PR cannot be loaded. `restack` still fails closed on an incomplete snapshot set.

`A` squash-merges into `main`:

```text
main: M-S
```

`S` contains the tree change of `A1` and `A2`. The original `A1`/`A2` SHAs are not ancestors of `main`.

After absorption, `B` and any siblings record `parent = main`. `C` still records `parent = B`. Restack then rebases unique commits only:

```text
git rebase --onto origin/main A2 B
```

which is `git rebase --onto S <old-A-tip> B`. Result:

```text
B: M-S-B1'-B2'
C: M-S-B1'-B2'-C1'   (after C is restacked onto B)
```

`A1`/`A2` are not replayed. They are not in `A2..B`. Only `B1` and `B2` are. A no-fast-forward merge uses the same planner. The two-parent merge commit is usually an ancestor of `main`; the squash commit is not.

The local Git branch is deleted only when it exists, is not checked out, is not held by another worktree, and `git merge-base --is-ancestor branchTip newBase` is true. Otherwise it is kept and the reason is printed. Squash merges are not contained, so the local branch stays. A restack plan already in progress skips absorption so parentage is not rewritten under that plan.

## What metadata distinguishes A from B

`B.lastRestackBase` is the SHA of `A` at the last time `B` was created or restacked. That SHA is `A2` in the example. Everything after `A2` on `B` belongs to `B`, even if `A2` later disappears from `main`.

Remote PR property `ado-stack.last-restack-base` stores the same SHA so a fresh clone can rebuild the range after `ado-stack init`.

## Safety checks

Before `rebase --onto`:

- the branch is in the tracked stack
- `oldBase` is an ancestor of the branch
- the unique commit list is non-empty
- the remote tip equals `lastKnownRemoteTip` (no unknown remote commits)
- a branch with no pull request and no `lastSubmittedTip` is rebased locally and not pushed
- every branch in the operation set is mapped to the worktree that holds it

If another worktree holds a branch and `git status --porcelain` is empty, restack runs `git -C <path> rebase --onto` there and leaves that worktree on the rebased branch. If any holding worktree is dirty, every held branch is named with its path and the whole restack is refused. Free siblings are not rebased or pushed.

After a successful restack the invoking worktree is left on the branch it started on.

A conflict leaves `git rebase` in progress and writes `.git/ado-stack/restack-in-progress.json`. Resolve, `git rebase --continue`, then `ado-stack restack --continue`. `ado-stack restack --abort` aborts the Git rebase and clears the plan. Submitted branches already force-pushed with lease are not rolled back.

## Scoped restack

`ado-stack restack --stack <branch>` limits the run to the tree containing `<branch>`: its root (the tracked ancestor whose parent is trunk) and every descendant. The branch argument accepts the short name shown by `status` when a `branchPrefix` is configured. The scope applies to the whole run — completed-merge reconciliation, pull request snapshot loading, and planning are all restricted to the tree — so branches outside it are never rebased, retargeted, absorbed, or even loaded, and a broken sibling cannot abort the scoped run. `--stack` cannot be combined with `--continue`, `--abort`, or `--status` — those operate on the plan already in progress, which keeps its original scope.

## Machine-readable restack

`ado-stack restack --json` prints one JSON object per line on stdout while human messages go to stderr. Events: `plan` (the ordered steps), `step-start`, `step-done`, `conflict` (branch, the worktree path holding the rebase, conflicted files, blocked subtree, untouched siblings), `done`, `aborted`, and `error`. The same flag works with `--continue` and `--abort`. Exit codes are unchanged — a conflict still exits non-zero after emitting the `conflict` event.

`ado-stack restack --status --json` prints a single object with the persisted plan (or `null`), the branch a conflict stopped on, and the live rebase state (in progress or not, worktree path, currently conflicted files). It only reads; nothing is fetched or rewritten. The desktop app is built on these two surfaces.

## Divergence

If another clone pushed to `B`, `origin/B` no longer matches `lastKnownRemoteTip`. Restack errors with both SHAs and does not push. `--force-with-lease` is a second check, not the only one.
