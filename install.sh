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
