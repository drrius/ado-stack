#!/bin/sh
# Install ado-stack from GitHub Releases.
# curl -fsSL https://raw.githubusercontent.com/drrius/ado-stack/main/install.sh | sh
set -eu

REPO="${ADO_STACK_GITHUB_REPO:-drrius/ado-stack}"
VERSION="${ADO_STACK_VERSION:-latest}"
PREFIX="${ADO_STACK_INSTALL_DIR:-${HOME}/.local/bin}"

os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)

case "${os}" in
  linux) target="linux-x64" ;;
  darwin)
    case "${arch}" in
      arm64|aarch64) target="darwin-arm64" ;;
      x86_64|amd64) target="darwin-x64" ;;
      *) echo "Unsupported macOS architecture: ${arch}" >&2; exit 1 ;;
    esac
    ;;
  mingw*|msys*|cygwin*|windows)
    echo "Use install.ps1 on Windows." >&2
    exit 1
    ;;
  *)
    echo "Unsupported OS: ${os}" >&2
    exit 1
    ;;
esac

asset="ado-stack-${target}"
tmpdir=$(mktemp -d)
trap 'rm -rf "${tmpdir}"' EXIT

download_failed() {
  echo "No GitHub Release found for ${REPO} (${VERSION})." >&2
  echo "Publish a v* tag to create one, then retry:" >&2
  echo "  git tag vX.Y.Z && git push origin vX.Y.Z" >&2
  echo "If the repository is private, run gh auth login and retry." >&2
  exit 1
}

download_with_gh() {
  name=$1
  if [ "${VERSION}" = "latest" ]; then
    gh release download --repo "${REPO}" --pattern "${name}" --dir "${tmpdir}"
  else
    gh release download "${VERSION}" --repo "${REPO}" --pattern "${name}" --dir "${tmpdir}"
  fi
}

download() {
  url=$1
  dest=$2
  name=$(basename "${url}")

  if command -v curl >/dev/null 2>&1; then
    if curl -fsSL "${url}" -o "${dest}"; then
      return
    fi
  fi

  if command -v gh >/dev/null 2>&1; then
    if download_with_gh "${name}"; then
      return
    fi
  elif ! command -v curl >/dev/null 2>&1; then
    echo "Need curl or gh to download ${url}" >&2
    exit 1
  fi

  download_failed
}

if [ "${VERSION}" = "latest" ]; then
  api="https://github.com/${REPO}/releases/latest/download"
else
  api="https://github.com/${REPO}/releases/download/${VERSION}"
fi

download "${api}/${asset}" "${tmpdir}/${asset}"
download "${api}/SHA256SUMS" "${tmpdir}/SHA256SUMS"

expected=$(awk -v name="${asset}" '$2 == name { print $1 }' "${tmpdir}/SHA256SUMS")
if [ -z "${expected}" ]; then
  echo "No SHA256 entry for ${asset} in SHA256SUMS" >&2
  exit 1
fi
actual=$(sha256sum "${tmpdir}/${asset}" 2>/dev/null | awk '{print $1}')
if [ -z "${actual}" ]; then
  actual=$(shasum -a 256 "${tmpdir}/${asset}" | awk '{print $1}')
fi
if [ "${expected}" != "${actual}" ]; then
  echo "Checksum mismatch for ${asset}" >&2
  echo "expected ${expected}" >&2
  echo "actual   ${actual}" >&2
  exit 1
fi

mkdir -p "${PREFIX}"
install_path="${PREFIX}/ado-stack"
cp "${tmpdir}/${asset}" "${install_path}"
chmod +x "${install_path}"

echo "Installed ${install_path}"
case ":${PATH}:" in
  *":${PREFIX}:"*) ;;
  *)
    echo "Add ${PREFIX} to PATH, for example:"
    echo "  export PATH=\"${PREFIX}:\$PATH\""
    ;;
esac
