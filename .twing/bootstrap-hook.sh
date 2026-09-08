#!/bin/sh
# twing-bootstrap-hook-v4
#
# Committed by `twing init` / `twing project enable-enforcement`. Every
# clone of this repo coordinates through twing without anyone installing
# anything: this script sets twing up on first use, then hands the real
# decision to the installed binary.
#
# Do not edit by hand -- it is regenerated wholesale, and a modified copy
# is replaced the next time an admin re-runs either command above.
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

# First use on a machine that has never run twing: set it up rather than
# demanding someone else do it. Everything here is unprivileged -- the
# install prefix is under $HOME (no sudo, unlike npm install -g), and
# --unattended skips the OS-service step.
#
# Output goes to a log rather than /dev/null. Discarding it meant a
# precise, actionable error (`gh auth login` is the common one) was thrown
# away and replaced by a message guessing at three possible causes -- see
# the deny text below, which now points here instead.
lib="$HOME/.twing/lib"
cli="$lib/node_modules/@twing/cli/dist/index.js"
log="$HOME/.twing/bootstrap.log"
mkdir -p "$HOME/.twing"
echo "=== twing bootstrap $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" >> "$log" 2>/dev/null

# Reuse a twing that is already on PATH before fetching another copy: a
# machine with a working global install needs no download at all, and
# installing a second copy beside it is confusing to anyone inspecting this
# script (it reads as the repo insisting on its own binary).
if command -v twing >/dev/null 2>&1; then
  twing init --unattended >> "$log" 2>&1 </dev/null
fi
if [ ! -x "$hook_bin" ]; then
  npm install --prefix "$lib" @twing/cli@latest --no-fund --no-audit --loglevel=error >> "$log" 2>&1 </dev/null
  [ -f "$cli" ] && node "$cli" init --unattended >> "$log" 2>&1 </dev/null
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
printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"twing could not install itself on this machine, so this repo is not coordinating edits right now.\n\n  This repo uses twing (https://twing.dev, source at\n  https://github.com/Twing-dev/twing-cli) to stop two AI sessions\n  silently colliding on the same code. Its setup runs automatically\n  from a hook this repo commits -- normally with nothing to do by\n  hand -- and that automatic setup just failed.\n\n  This is an operational failure, not a task for you to work around:\n  do not try to install it another way, and do not edit or remove the\n  hook (that hits this same check anyway). Report it to whoever runs\n  this repo.\n\n  The actual error was written to ~/.twing/bootstrap.log -- read that\n  file and report what it says. Do not guess from this message; the\n  log has the real cause. The most common one is that twing needs a\n  GitHub credential to verify your access to this repo, and none was\n  available non-interactively, which `gh auth login` fixes."}}'
exit 0
