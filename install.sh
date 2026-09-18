#!/bin/sh
set -eu

# One-step twing setup, without a global npm install.
#
# Wires twing into Claude Code and OpenCode for every directory on this
# machine, and installs nothing permanent: the CLI is fetched into a throwaway
# prefix only to run its setup, then deleted. The real install happens lazily,
# the first time a session opens a repo that uses twing, at the version that
# repo's coordinator asks for -- and version recovery keeps it current.

command -v npm >/dev/null 2>&1 && command -v node >/dev/null 2>&1 || {
  echo "twing install: node and npm are required (Node.js 20 or newer)" >&2
  exit 1
}

# Present is not the same as new enough, and this script used to claim a
# version it never checked. npm only *warns* on an unsatisfiable `engines`
# field, so an old Node gets a successful-looking install that fails later
# inside the CLI, with an error naming a file the reader has never seen.
#
# Kept in step with MIN_NODE_MAJOR/MIN_NODE_MINOR in
# packages/core/src/repo-setup.ts, which is where the two zero-touch install
# paths read the same floor from. This script is standalone by necessity --
# it is fetched over curl before any of that exists.
node_version=$(node -v 2>/dev/null | sed 's/^v//')
node_major=${node_version%%.*}
node_rest=${node_version#*.}
node_minor=${node_rest%%.*}
case "$node_major" in ''|*[!0-9]*) node_major=0 ;; esac
case "$node_minor" in ''|*[!0-9]*) node_minor=0 ;; esac
if [ "$node_major" -lt 22 ] || { [ "$node_major" -eq 22 ] && [ "$node_minor" -lt 5 ]; }; then
  echo "twing install: this machine runs Node ${node_version:-unknown}, and twing needs 22.5 or newer." >&2
  echo "twing install: nothing was installed. Upgrade Node and run this again." >&2
  exit 1
fi

tmp=$(mktemp -d "${TMPDIR:-/tmp}/twing-install.XXXXXX")
trap 'rm -rf "$tmp"' EXIT INT TERM

# --ignore-scripts: nothing in the tree needs one (tree-sitter grammars load as
# WASM), and the package's own setup runs explicitly below.
npm install --prefix "$tmp" --ignore-scripts --no-save --no-fund --no-audit --loglevel=error @twing/cli@latest
node "$tmp/node_modules/@twing/cli/postinstall.cjs" --machine-setup

[ -f "${HOME}/.twing/bin/twing-resolve" ] || {
  echo "twing install: machine wiring was not written" >&2
  exit 1
}
