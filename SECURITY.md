# Security

## Reporting

If you find a vulnerability in ado-stack, email the maintainer listed on the GitHub repository. Do not file a public issue for credential leaks or auth bypasses.

## Credentials

Personal access tokens and Entra/Azure CLI tokens are secrets.

ado-stack never writes them to:

- the Git repository
- `.git/ado-stack/state.json`
- PR descriptions or titles
- debug logs

Optional PAT storage is a user-level `credentials.json` with mode 0600. Prefer `AZURE_DEVOPS_EXT_PAT` or `az login` when you can.

Do not pass a PAT on the command line. Shell history keeps it.

`--debug` redacts `Authorization` headers, `Bearer` / `Basic` values, and PAT-like tokens.

## Git history

Published branches are rewritten only with `git push --force-with-lease=<branch>:<expected-sha>`. ado-stack also compares the fetched remote tip to `lastKnownRemoteTip` before that push. Unknown remote commits abort the restack.

The tool does not delete remote branches.

It does not discard a dirty working tree.

## Supply chain

Release binaries are published with `SHA256SUMS`. `install.sh` and `install.ps1` refuse to install on checksum mismatch.
