#!/bin/sh
# twing-bootstrap-hook-v4
#
# Committed by `twing init` / `twing project enable-enforcement` / the
# GitHub App setup flow. Every clone of this repo coordinates through twing
# without anyone installing anything: this script sets twing up on first
# use, then hands the real decision to the installed binary.
#
# Do not edit by hand -- it is regenerated wholesale, and a modified copy
# is replaced the next time an admin re-runs any of the above.
#
# $1 is the Claude Code hook event this entry is wired for.

twing_event="$1"
hook_bin="$HOME/.twing/bin/twing-hook"
settings="$HOME/.claude/settings.json"

# Already wired machine-globally: that entry handles this event, so stay
# silent. Claude Code merges hooks across settings scopes and runs all of
# them -- without this guard both would fire for every tool call.
if [ -f "$settings" ] && grep -qF "$hook_bin" "$settings" 2>/dev/null; then
  exit 0
fi

# The steady state, and the whole cost of it: no subprocess, no git. The
# binary itself resolves this repo's coordinator and exits silently if
# there is none, so there is nothing to check here first.
if [ -x "$hook_bin" ]; then
  exec "$hook_bin"
fi

# Not installed. Only now is it worth asking git anything -- once per
# machine rather than once per tool call.
repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
if [ -z "$repo_root" ] || [ ! -f "$repo_root/.twing/twing.yml" ]; then
  exit 0
fi

# Is the Node already on this machine new enough to run what is about to be
# installed?
#
# npm does not refuse an install over an unsatisfiable `engines` field -- it
# prints EBADENGINE and carries on -- so without this the install "succeeds"
# and the failure surfaces later, inside `init`, as a missing-API or syntax
# error in a file the reader has never heard of. On this path that error goes
# to bootstrap.log, and the gate meanwhile denies every edit with a message
# listing causes that do not include the real one.
#
# Parameter expansion rather than sed/cut: this runs before twing exists on a
# machine, and it saves three subprocesses on the path that has none to spare.
twing_node_ok() {
  _nv=$(node -v 2>/dev/null) || return 1
  _nv=${_nv#v}
  _major=${_nv%%.*}
  _rest=${_nv#*.}
  _minor=${_rest%%.*}
  case "$_major" in ''|*[!0-9]*) return 1 ;; esac
  case "$_minor" in ''|*[!0-9]*) _minor=0 ;; esac
  [ "$_major" -gt 22 ] && return 0
  [ "$_major" -eq 22 ] && [ "$_minor" -ge 5 ]
}

# Says so through the one channel a person actually reads.
#
# The paths that reach this are asynchronous -- nobody is watching a terminal
# when the resolver or the committed hook runs -- so writing the reason to
# bootstrap.log means writing it nowhere. A `PreToolUse` deny is the only
# channel that surfaces: it reaches the agent, which reports it. Every other
# event has nowhere to put a verdict, so it stays quiet.
#
# Reads $twing_event, which both generated scripts set from their first
# argument before this is sourced.
# Everything that happens when this machine's node is too old, in one place:
# record it where a maintainer would look, then tell the agent, which is the
# only way it reaches a person. Both generated scripts call this instead of
# deciding for themselves, so the wording cannot drift between them.
twing_node_unusable() {
  mkdir -p "$HOME/.twing" 2>/dev/null
  echo "twing: node $(node -v 2>/dev/null || echo 'not found') is older than the Node 22.5 twing requires -- not installing, and nothing was changed" >> "$HOME/.twing/bootstrap.log" 2>/dev/null
  twing_node_deny
}

twing_node_deny() {
  [ "${twing_event:-}" = "PreToolUse" ] || return 0
  _found=$(node -v 2>/dev/null) || _found=""
  [ -n "$_found" ] || _found="not found"
  # `%s` as the whole format, with the JSON as an argument -- printf expands
  # backslash escapes in a *format* string, which would turn every \n in the
  # message into a real newline and produce invalid JSON. The version is
  # spliced in by ending the single-quoted run rather than by a placeholder,
  # for the same reason.
  printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"twing cannot set itself up on this machine: it needs Node 22.5 or newer, and this machine runs '"$_found"'.\n\n  This repo uses twing (https://twing.dev) to stop two AI sessions\n  silently colliding on the same code. Its setup normally runs\n  automatically, with nothing to do by hand -- but it will not install\n  against a Node this old, because that produces a broken install\n  rather than a working one.\n\n  Nothing was installed and nothing on this machine was changed.\n  Upgrading Node is all it needs; twing will set itself up on the next\n  edit.\n\n  This is an operational problem, not a task for you to work around:\n  do not try to install twing another way, and do not edit or remove\n  the hook. Report the Node version to whoever runs this machine."}}'
}

twing_fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 10 "$1" 2>/dev/null
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- --timeout=10 "$1" 2>/dev/null
  fi
}

# Installs twing for the repo at $1, pinned to that repo's coordinator.
twing_install_for_repo() {
  _root="$1"
  _lib="$HOME/.twing/lib"
  _cli="$_lib/node_modules/@twing/cli/dist/index.js"
  _log="$HOME/.twing/bootstrap.log"
  mkdir -p "$HOME/.twing"
  echo "=== twing bootstrap $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" >> "$_log" 2>/dev/null

  # Before anything is downloaded. Returning early leaves the machine exactly
  # as it was -- no half-installed lib, no hook binary -- which is the state
  # the caller's own "did it work?" check already handles.
  if ! twing_node_ok; then
    echo "twing: node $(node -v 2>/dev/null || echo 'not found') is too old -- twing needs Node 22.5 or newer, and will not install until it is upgraded" >> "$_log" 2>/dev/null
    return 1
  fi

  # coordinator.serverUrl straight out of the committed manifest.
  _server=$(sed -n 's/^[[:space:]]*serverUrl:[[:space:]]*//p' "$_root/.twing/twing.yml" 2>/dev/null | head -1 | tr -d '"' | tr -d '\r')

  _spec="@twing/cli@latest"
  if [ -n "$_server" ]; then
    # Two plain substitutions rather than a capture group: a sed
    # backreference is an illegal octal escape inside the JS template
    # literal this script is generated from.
    _version=$(twing_fetch "$_server/v1/version" | sed -e 's/.*"version"[[:space:]]*:[[:space:]]*"//' -e 's/".*//')
    [ -n "$_version" ] && _spec="@twing/cli@$_version"
  fi
  echo "twing: installing $_spec (coordinator $_server)" >> "$_log" 2>/dev/null

  npm install --prefix "$_lib" "$_spec" --no-fund --no-audit --loglevel=error >> "$_log" 2>&1 </dev/null

  # From the repo, in a subshell. `init` resolves the coordinator from its own
  # cwd, and the caller's cwd is not reliably inside the repo being installed
  # for: a session started above it (`cd ~/work && claude`, then edit a file
  # below) is exactly the case the resolver identifies by file path instead.
  # Installing the CLI and then failing with "no coordinator configured" left
  # the machine half-set-up -- lib present, no hook binary, nothing gated.
  [ -f "$_cli" ] && ( cd "$_root" && node "$_cli" init --unattended ) >> "$_log" 2>&1 </dev/null
}

# First use on a machine that has never run twing: set it up rather than
# demanding someone else do it. Everything here is unprivileged -- the
# install prefix is under $HOME (no sudo, unlike npm install -g), and
# --unattended skips the OS-service step.
#
# Output goes to a log rather than /dev/null. Discarding it meant a
# precise, actionable error (`gh auth login` is the common one) was thrown
# away and replaced by a message guessing at three possible causes -- see
# the deny text below, which now points here instead.
log="$HOME/.twing/bootstrap.log"
mkdir -p "$HOME/.twing"

# Before either install route below, and before the generic failure text at
# the bottom: that text lists everything that can go wrong and asks the
# reader to go find the real cause in bootstrap.log. When the cause is
# already known, say it here instead of sending someone log-hunting.
if ! twing_node_ok; then
  twing_node_unusable
  exit 0
fi

# Reuse a twing that is already on PATH before fetching another copy: a
# machine with a working global install needs no download at all, and
# installing a second copy beside it is confusing to anyone inspecting this
# script (it reads as the repo insisting on its own binary).
if command -v twing >/dev/null 2>&1; then
  twing init --unattended >> "$log" 2>&1 </dev/null
fi
if [ ! -x "$hook_bin" ]; then
  twing_install_for_repo "$repo_root"
fi

if [ -x "$hook_bin" ]; then
  exec "$hook_bin"
fi

# Bootstrap failed. Only PreToolUse can carry a verdict; for every other
# event there is nothing useful to say and no way to say it, so stay quiet
# rather than emit output Claude Code would not understand.
if [ "$twing_event" != "PreToolUse" ]; then
  exit 0
fi
printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"twing could not install itself on this machine, so this repo is not coordinating edits right now.\n\n  This repo uses twing (https://twing.dev, source at\n  https://github.com/Twing-dev/twing-cli) to stop two AI sessions\n  silently colliding on the same code. Its setup runs automatically\n  from a hook this repo commits -- normally with nothing to do by\n  hand -- and that automatic setup just failed.\n\n  This is an operational failure, not a task for you to work around:\n  do not try to install it another way, and do not edit or remove the\n  hook (that hits this same check anyway). Report it to whoever runs\n  this repo.\n\n  The actual error was written to ~/.twing/bootstrap.log -- read that\n  file and report what it says. Do not guess from this message; the\n  log has the real cause. This step needs no GitHub credential and no\n  sign-in of any kind -- it only downloads twing itself, so a GitHub\n  auth problem is never the cause here (that shows up later, as a\n  different, separate message, once twing is actually installed).\n  Look instead for: no network/DNS, the npm registry or github.com\n  specifically blocked or unreachable (a corporate proxy can allow\n  one and not the other), the wrong OS/CPU release asset missing for\n  this machine, `npm`/`node` not on PATH in the environment Claude\n  Code itself runs in, or no free disk space under $HOME."}}'
exit 0
