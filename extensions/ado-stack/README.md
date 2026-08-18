# ado-stack

Sidebar over the `ado-stack` CLI. Every action shells out to `ado-stack`. There is no second copy of stack, Git, or Azure DevOps logic.

## Install

1. Install the CLI so `ado-stack` is on your `PATH`. From this repo you can also point the setting below at `bun /absolute/path/to/src/index.ts`.
2. In VS Code or Cursor, Command Palette → **Extensions: Install from VSIX…**
3. Pick `ado-stack.vsix` in this directory.
4. Open a Git workspace and run `ado-stack init` if you have not already.

If the executable is not on `PATH`, set **adoStack.command** to an absolute path.

## Use

The **ado-stack** activity-bar icon opens the stack tree. Click a row to check that branch out.

Command Palette:

- ado-stack: Refresh
- ado-stack: Checkout Branch (picks a branch when you did not click the tree)
- ado-stack: Restack
- ado-stack: Submit
- ado-stack: Up (asks which child when the current branch has more than one)
- ado-stack: Down
- ado-stack: Init

Missing binary → error. No state → **Run init**. A Git rebase conflict → resolve it, then `ado-stack restack --continue`. An Azure DevOps conflict is not a rebase.

Rebuild with `bun run extension:package` from the repo root.
