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

## Squash merge

`A` squash-merges into `main`:

```text
main: M-S
```

`S` contains the tree change of `A1` and `A2`. The original `A1`/`A2` SHAs are not ancestors of `main`.

Azure DevOps marks PR `A` completed. Restack walks completed parents until it finds a living base (`main`). Then:

```text
git rebase --onto origin/main A2 B
```

which is `git rebase --onto S <old-A-tip> B`. Result:

```text
B: M-S-B1'-B2'
C: M-S-B1'-B2'-C1'   (after C is restacked onto B)
```

`A1`/`A2` are not replayed. They are not in `A2..B`. Only `B1` and `B2` are.

`B`'s PR is retargeted to `main`. `C` still targets `B`. `A` is dropped from tracked stack state once no remaining child records it as parent. If `A` had several children, restack keeps `A` until every surviving child has been reparented, so a conflict or abort cannot leave a missing parent. Local Git branches are not deleted.

## What metadata distinguishes A from B

`B.lastRestackBase` is the SHA of `A` at the last time `B` was created or restacked. That SHA is `A2` in the example. Everything after `A2` on `B` belongs to `B`, even if `A2` later disappears from `main`.

Remote PR property `ado-stack.last-restack-base` stores the same SHA so a fresh clone can rebuild the range after `ado-stack init`.

## Safety checks

Before `rebase --onto`:

- the branch is in the tracked stack
- `oldBase` is an ancestor of the branch
- the unique commit list is non-empty
- the remote tip equals `lastKnownRemoteTip` (no unknown remote commits)
- every branch in the operation set is mapped to the worktree that holds it

If another worktree holds a branch and `git status --porcelain` is empty, restack runs `git -C <path> rebase --onto` there and leaves that worktree on the rebased branch. If any holding worktree is dirty, every held branch is named with its path and the whole restack is refused. Free siblings are not rebased or pushed. ado-stack does not move a held branch with `git update-ref` or `git branch -f`.

After a successful restack the invoking worktree is left on the branch it started on.

A conflict leaves `git rebase` in progress and writes `.git/ado-stack/restack-in-progress.json`. Resolve, `git rebase --continue`, then `ado-stack restack --continue`. `ado-stack restack --abort` aborts the Git rebase and clears the plan. Branches already force-pushed with lease are not rolled back.

## Divergence

If another clone pushed to `B`, `origin/B` no longer matches `lastKnownRemoteTip`. Restack errors with both SHAs and does not push. `--force-with-lease` is a second check, not the only one.
