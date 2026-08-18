# Contributing

This repo is a Bun + TypeScript CLI. Runtime Git uses the `git` executable. Azure DevOps calls use `fetch`.

## Setup

```bash
bun install --frozen-lockfile
```

Bun 1.3+ is required for development. Users of the compiled binary do not need Bun.

## Checks

```bash
bun run verify
```

That runs lint, format check, typecheck, tests, compile, and a `--help` / `--version` smoke test.

Individual scripts:

```bash
bun run lint
bun run format:check
bun run typecheck
bun test
bun run build
```

## Tests

- Unit tests sit next to the code (`src/**/*.test.ts`).
- Real Git tests under `test/git` create temporary repositories and run `git`.
- Fake Azure DevOps tests under `test/ado` start an in-process HTTP server.
- Live tests under `test/live` run only when `ADO_TEST_ORG`, `ADO_TEST_PROJECT`, `ADO_TEST_REPO`, and `ADO_TEST_PAT` are set.

Do not mock Git for restack or ownership tests. If a test fails, fix the code, not the assertion.

## Docs

Behavior changes to restack or state should update `docs/restacking.md` and `docs/architecture.md` in the same change.

## Patches

Keep diffs small. Linear stacks only. No GitHub/GitLab support, telemetry, or automatic conflict resolution in this MVP.

## Releasing

`install.sh` downloads binaries from GitHub Releases. A public repo with no published release prints `release not found`.

Every pull request targeting `main` must bump `package.json` `version` to a greater strict `X.Y.Z`. The `require-version-bump` workflow fails the PR if the version is unchanged, lower, or not a strict `X.Y.Z`. A push to `main` re-runs that check on open PRs. That stops a stale green check from merging after `main` already took the same version. Merge queues re-check at merge time.

Merge to `main` still tags via `tag-release` when the version moved up. `tag-release` creates the lightweight `vX.Y.Z` tag when the new version is greater than the latest `v*` tag and that tag does not already exist. Reverts and equal or lower versions are no-ops. A duplicate tag is a no-op.

The `release` workflow still compiles binaries, writes `SHA256SUMS`, and publishes the GitHub Release when the tag exists.

If you need to tag by hand:

```bash
git tag v0.2.3
git push origin v0.2.3
```
