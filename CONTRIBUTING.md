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
