#!/bin/sh
set -eu

# One persistent, unprivileged Twing install. This is deliberately not npx:
# OpenCode's global loader and the daemon launch marker must keep pointing at
# code that will still exist after npm evicts its cache.
twing_lib="${HOME}/.twing/lib"
twing_cli="${twing_lib}/node_modules/@twing/cli/dist/index.js"

command -v npm >/dev/null 2>&1 || {
  echo "twing install: npm is required (Node.js 20 or newer)" >&2
  exit 1
}

mkdir -p "${twing_lib}"
cat > "${twing_lib}/package.json" <<'JSON'
{
  "private": true,
  "allowScripts": {
    "@twing/cli": true,
    "tree-sitter-javascript": true,
    "tree-sitter-typescript": true
  }
}
JSON
npm install --prefix "${twing_lib}" @twing/cli@latest --no-fund --no-audit --loglevel=error

# @twing/cli's npm postinstall normally performs machine setup. npm 12 or a
# local policy may suppress dependency lifecycle scripts; the shell installer
# is already explicitly trusted code, so complete the same package-owned setup
# directly when that happens. This remains one user action and one code path.
[ -f "${twing_cli}" ] || {
  echo "twing install: npm did not install the CLI at ${twing_cli}" >&2
  exit 1
}
if [ ! -x "${HOME}/.twing/bin/twing-hook" ] || \
   [ ! -f "${HOME}/.config/opencode/plugins/twing.js" ] || \
   ! grep -qF "${HOME}/.twing/bin/twing-hook" "${HOME}/.claude/settings.json" 2>/dev/null; then
  node "${twing_lib}/node_modules/@twing/cli/postinstall.cjs"
fi
[ -x "${HOME}/.twing/bin/twing-hook" ] || {
  echo "twing install: machine hooks were not installed" >&2
  exit 1
}
[ -f "${HOME}/.config/opencode/plugins/twing.js" ] || {
  echo "twing install: OpenCode's global plugin was not installed" >&2
  exit 1
}
