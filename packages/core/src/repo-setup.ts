/**
 * Pure generation logic for the three committed onboarding artifacts
 * (`.twing/bootstrap-hook.sh`, its `.claude/settings.json` hook entries,
 * `.twing/twing.yml`'s `coordinator.serverUrl`) -- extracted out of
 * `packages/cli/src/enforce-hooks.ts` so a second write path can produce
 * byte-identical output without re-deriving it.
 *
 * That second path is `packages/server`'s GitHub App Setup URL route: it
 * writes the same three files via GitHub's Contents API instead of local
 * disk, for an admin who never installs the CLI at all. Everything here is
 * string/object in, string/object out -- no `fs`, no prompts -- so both
 * `enforce-hooks.ts` (disk) and the server route (Contents API) call the
 * exact same generator and can't drift apart. `.twing/twing.yml`'s
 * coordinator-serverUrl rendering is the manifest's own concern and stays in
 * `manifest.ts` (`renderManifestWithCoordinator`) rather than here, since
 * it's the counterpart to that file's existing `upsertCoordinatorServerUrl`.
 */

import type { ClaudeSettings, HookCommand, HookMatcherEntry } from "./claude-settings.js";

export const BOOTSTRAP_HOOK_MARKER = "# twing-bootstrap-hook-v4";

/**
 * Every marker string this hook has ever shipped under, current one first.
 * See `enforce-hooks.ts`'s original header comment (preserved there) for why
 * this list only ever grows.
 */
export const KNOWN_BOOTSTRAP_HOOK_MARKERS = [
  BOOTSTRAP_HOOK_MARKER,
  "# twing-bootstrap-hook-v3",
  "# twing-install-enforcement-hook-v2",
  "# twing-install-enforcement-hook-v1",
];

/** Repo-relative location of the committed script. POSIX-joined (`/`), not
 * `path.join`: this file has no platform-specific path handling, and the
 * value is used both as a filesystem-relative path (`enforce-hooks.ts`, any
 * platform) and as a GitHub Contents API path (always `/`-separated,
 * regardless of the server's own platform). */
export const BOOTSTRAP_SCRIPT_RELPATH = ".twing/bootstrap-hook.sh";

/**
 * Every hook event the committed entries cover, mirroring `wire-hooks.ts`'s
 * global set exactly. The two wiring sources must stay identical in
 * coverage -- see `enforce-hooks.ts`'s original comment.
 */
export const WIRED_HOOK_EVENTS: { event: string; matcher?: string }[] = [
  { event: "PreToolUse", matcher: "ExitPlanMode" },
  { event: "PreToolUse", matcher: "Edit|Write" },
  { event: "PostToolUse", matcher: "Edit|Write|Read|Grep|Glob" },
  { event: "SessionStart" },
  { event: "UserPromptSubmit" },
  { event: "SessionEnd" },
];

/**
 * The shell that installs twing for one repo, pinned to that repo's own
 * coordinator.
 *
 * Shared verbatim by the two scripts that can face a machine with no twing
 * on it: the committed bootstrap hook below, and `twing-resolve`
 * (`packages/cli/src/resolve-hook.ts`) for sessions that never load a
 * repo's committed file.
 *
 * **Why it asks the coordinator instead of installing `@latest`.** Version
 * matching is exact and blocks in *both* directions. A coordinator sitting
 * one release behind npm -- a staged rollout, a pinned deployment -- would
 * therefore deny the very first gate call from a machine that just
 * installed `@latest`, and version recovery would immediately *downgrade*
 * it: two installs, and a daemon running a version nobody asked for in
 * between. `GET /v1/version` is unauthenticated (it is in the auth
 * middleware's exempt list, so it answers on a `--no-auth` coordinator
 * too), so this costs one request at the only moment it matters.
 *
 * Shell rather than a twing command, because it runs before any twing
 * binary exists. With neither `curl` nor `wget` present it falls back to
 * `@latest` -- no worse than what it replaced.
 */
/**
 * The oldest Node that can run the installed CLI, as one source of truth.
 *
 * Declared in both published `package.json`s so npm warns, checked by
 * `install.sh`, and interpolated into the shell below so the two zero-touch
 * paths check it too. Raising the floor means editing this and the two
 * manifests; every install path follows from here.
 *
 * **22.5, as of 2026-09-18** (was 20.0). Two independent reasons, either
 * sufficient:
 *
 *  - Node 20 reached end-of-life on 2026-04-30. A floor below the oldest
 *    security-supported release is not a floor anyone should be standing on,
 *    and twing installs itself onto other people's machines.
 *  - `node:sqlite` lands in 22.5, and session capture needs it to read
 *    OpenCode's conversation store -- OpenCode keeps conversations in SQLite,
 *    not a file. Below 22.5 that capture could only degrade to a silent
 *    no-op on a machine that satisfies twing's stated requirement, which is
 *    the shape this codebase has been deliberately removing elsewhere.
 *
 * 22.5 rather than 22.0 because that is the version the feature actually
 * needs; rather than 24, because 22 is the active LTS (EOL 2027-04-30) and
 * there is no reason to exclude it.
 */
export const MIN_NODE_MAJOR = 22;
export const MIN_NODE_MINOR = 5;

export function coordinatorInstallShell(): string {
  return `
# Is the Node already on this machine new enough to run what is about to be
# installed?
#
# npm does not refuse an install over an unsatisfiable \`engines\` field -- it
# prints EBADENGINE and carries on -- so without this the install "succeeds"
# and the failure surfaces later, inside \`init\`, as a missing-API or syntax
# error in a file the reader has never heard of. On this path that error goes
# to bootstrap.log, and the gate meanwhile denies every edit with a message
# listing causes that do not include the real one.
#
# Parameter expansion rather than sed/cut: this runs before twing exists on a
# machine, and it saves three subprocesses on the path that has none to spare.
twing_node_ok() {
  _nv=\$(node -v 2>/dev/null) || return 1
  _nv=\${_nv#v}
  _major=\${_nv%%.*}
  _rest=\${_nv#*.}
  _minor=\${_rest%%.*}
  case "\$_major" in ''|*[!0-9]*) return 1 ;; esac
  case "\$_minor" in ''|*[!0-9]*) _minor=0 ;; esac
  [ "\$_major" -gt ${MIN_NODE_MAJOR} ] && return 0
  [ "\$_major" -eq ${MIN_NODE_MAJOR} ] && [ "\$_minor" -ge ${MIN_NODE_MINOR} ]
}

# Says so through the one channel a person actually reads.
#
# The paths that reach this are asynchronous -- nobody is watching a terminal
# when the resolver or the committed hook runs -- so writing the reason to
# bootstrap.log means writing it nowhere. A \`PreToolUse\` deny is the only
# channel that surfaces: it reaches the agent, which reports it. Every other
# event has nowhere to put a verdict, so it stays quiet.
#
# Reads \$twing_event, which both generated scripts set from their first
# argument before this is sourced.
# Everything that happens when this machine's node is too old, in one place:
# record it where a maintainer would look, then tell the agent, which is the
# only way it reaches a person. Both generated scripts call this instead of
# deciding for themselves, so the wording cannot drift between them.
twing_node_unusable() {
  mkdir -p "\$HOME/.twing" 2>/dev/null
  echo "twing: node \$(node -v 2>/dev/null || echo 'not found') is older than the Node ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} twing requires -- not installing, and nothing was changed" >> "\$HOME/.twing/bootstrap.log" 2>/dev/null
  twing_node_deny
}

twing_node_deny() {
  [ "\${twing_event:-}" = "PreToolUse" ] || return 0
  _found=\$(node -v 2>/dev/null) || _found=""
  [ -n "\$_found" ] || _found="not found"
  # \`%s\` as the whole format, with the JSON as an argument -- printf expands
  # backslash escapes in a *format* string, which would turn every \\n in the
  # message into a real newline and produce invalid JSON. The version is
  # spliced in by ending the single-quoted run rather than by a placeholder,
  # for the same reason.
  printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"twing cannot set itself up on this machine: it needs Node ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} or newer, and this machine runs '"\$_found"'.\\n\\n  This repo uses twing (https://twing.dev) to stop two AI sessions\\n  silently colliding on the same code. Its setup normally runs\\n  automatically, with nothing to do by hand -- but it will not install\\n  against a Node this old, because that produces a broken install\\n  rather than a working one.\\n\\n  Nothing was installed and nothing on this machine was changed.\\n  Upgrading Node is all it needs; twing will set itself up on the next\\n  edit.\\n\\n  This is an operational problem, not a task for you to work around:\\n  do not try to install twing another way, and do not edit or remove\\n  the hook. Report the Node version to whoever runs this machine."}}'
}

twing_fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 10 "\$1" 2>/dev/null
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- --timeout=10 "\$1" 2>/dev/null
  fi
}

# Installs twing for the repo at \$1, pinned to that repo's coordinator.
twing_install_for_repo() {
  _root="\$1"
  _lib="\$HOME/.twing/lib"
  _cli="\$_lib/node_modules/@twing/cli/dist/index.js"
  _log="\$HOME/.twing/bootstrap.log"
  mkdir -p "\$HOME/.twing"
  echo "=== twing bootstrap \$(date -u +%Y-%m-%dT%H:%M:%SZ) ===" >> "\$_log" 2>/dev/null

  # Before anything is downloaded. Returning early leaves the machine exactly
  # as it was -- no half-installed lib, no hook binary -- which is the state
  # the caller's own "did it work?" check already handles.
  if ! twing_node_ok; then
    echo "twing: node \$(node -v 2>/dev/null || echo 'not found') is too old -- twing needs Node ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} or newer, and will not install until it is upgraded" >> "\$_log" 2>/dev/null
    return 1
  fi

  # coordinator.serverUrl straight out of the committed manifest.
  _server=\$(sed -n 's/^[[:space:]]*serverUrl:[[:space:]]*//p' "\$_root/.twing/twing.yml" 2>/dev/null | head -1 | tr -d '"' | tr -d '\\r')

  _spec="@twing/cli@latest"
  if [ -n "\$_server" ]; then
    # Two plain substitutions rather than a capture group: a sed
    # backreference is an illegal octal escape inside the JS template
    # literal this script is generated from.
    _version=\$(twing_fetch "\$_server/v1/version" | sed -e 's/.*"version"[[:space:]]*:[[:space:]]*"//' -e 's/".*//')
    [ -n "\$_version" ] && _spec="@twing/cli@\$_version"
  fi
  echo "twing: installing \$_spec (coordinator \$_server)" >> "\$_log" 2>/dev/null

  npm install --prefix "\$_lib" "\$_spec" --no-fund --no-audit --loglevel=error >> "\$_log" 2>&1 </dev/null

  # From the repo, in a subshell. \`init\` resolves the coordinator from its own
  # cwd, and the caller's cwd is not reliably inside the repo being installed
  # for: a session started above it (\`cd ~/work && claude\`, then edit a file
  # below) is exactly the case the resolver identifies by file path instead.
  # Installing the CLI and then failing with "no coordinator configured" left
  # the machine half-set-up -- lib present, no hook binary, nothing gated.
  [ -f "\$_cli" ] && ( cd "\$_root" && node "\$_cli" init --unattended ) >> "\$_log" 2>&1 </dev/null
}
`;
}

/** The committed script's exact contents. See `enforce-hooks.ts`'s original
 * header comment for the full design rationale (bootstraps rather than
 * blocks, a script file rather than an inlined string, etc.) -- unchanged by
 * this move, only its location. */
export function bootstrapHookScript(): string {
  return `#!/bin/sh
${BOOTSTRAP_HOOK_MARKER}
#
# Committed by \`twing init\` / \`twing project enable-enforcement\` / the
# GitHub App setup flow. Every clone of this repo coordinates through twing
# without anyone installing anything: this script sets twing up on first
# use, then hands the real decision to the installed binary.
#
# Do not edit by hand -- it is regenerated wholesale, and a modified copy
# is replaced the next time an admin re-runs any of the above.
#
# $1 is the Claude Code hook event this entry is wired for.

twing_event="\$1"
hook_bin="\$HOME/.twing/bin/twing-hook"
settings="\$HOME/.claude/settings.json"

# Already wired machine-globally: that entry handles this event, so stay
# silent. Claude Code merges hooks across settings scopes and runs all of
# them -- without this guard both would fire for every tool call.
if [ -f "\$settings" ] && grep -qF "\$hook_bin" "\$settings" 2>/dev/null; then
  exit 0
fi

# The steady state, and the whole cost of it: no subprocess, no git. The
# binary itself resolves this repo's coordinator and exits silently if
# there is none, so there is nothing to check here first.
if [ -x "\$hook_bin" ]; then
  exec "\$hook_bin"
fi

# Not installed. Only now is it worth asking git anything -- once per
# machine rather than once per tool call.
repo_root=\$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
if [ -z "\$repo_root" ] || [ ! -f "\$repo_root/.twing/twing.yml" ]; then
  exit 0
fi
${coordinatorInstallShell()}
# First use on a machine that has never run twing: set it up rather than
# demanding someone else do it. Everything here is unprivileged -- the
# install prefix is under \$HOME (no sudo, unlike npm install -g), and
# --unattended skips the OS-service step.
#
# Output goes to a log rather than /dev/null. Discarding it meant a
# precise, actionable error (\`gh auth login\` is the common one) was thrown
# away and replaced by a message guessing at three possible causes -- see
# the deny text below, which now points here instead.
log="\$HOME/.twing/bootstrap.log"
mkdir -p "\$HOME/.twing"

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
  twing init --unattended >> "\$log" 2>&1 </dev/null
fi
if [ ! -x "\$hook_bin" ]; then
  twing_install_for_repo "\$repo_root"
fi

if [ -x "\$hook_bin" ]; then
  exec "\$hook_bin"
fi

# Bootstrap failed. Only PreToolUse can carry a verdict; for every other
# event there is nothing useful to say and no way to say it, so stay quiet
# rather than emit output Claude Code would not understand.
if [ "\$twing_event" != "PreToolUse" ]; then
  exit 0
fi
${denyJsonLine()}
exit 0
`;
}

/** The bootstrap-failure verdict, as the single JSON line Claude Code reads
 * from stdout. See `enforce-hooks.ts`'s original comment. */
function denyJsonLine(): string {
  const reason = [
    "twing could not install itself on this machine, so this repo is not coordinating edits right now.",
    "",
    "  This repo uses twing (https://twing.dev, source at",
    "  https://github.com/Twing-dev/twing-cli) to stop two AI sessions",
    "  silently colliding on the same code. Its setup runs automatically",
    "  from a hook this repo commits -- normally with nothing to do by",
    "  hand -- and that automatic setup just failed.",
    "",
    "  This is an operational failure, not a task for you to work around:",
    "  do not try to install it another way, and do not edit or remove the",
    "  hook (that hits this same check anyway). Report it to whoever runs",
    "  this repo.",
    "",
    "  The actual error was written to ~/.twing/bootstrap.log -- read that",
    "  file and report what it says. Do not guess from this message; the",
    "  log has the real cause. This step needs no GitHub credential and no",
    "  sign-in of any kind -- it only downloads twing itself, so a GitHub",
    "  auth problem is never the cause here (that shows up later, as a",
    "  different, separate message, once twing is actually installed).",
    "  Look instead for: no network/DNS, the npm registry or github.com",
    "  specifically blocked or unreachable (a corporate proxy can allow",
    "  one and not the other), the wrong OS/CPU release asset missing for",
    "  this machine, `npm`/`node` not on PATH in the environment Claude",
    "  Code itself runs in, or no free disk space under $HOME.",
  ].join("\n");

  const payload = JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
  });
  // Single-quoted for sh, so nothing inside is expanded; the payload is
  // JSON and can never contain a single quote of its own.
  return `printf '%s' '${payload}'`;
}

/**
 * The hook entry pointing at this repo's committed script. See
 * `enforce-hooks.ts`'s original comment for why it's run through `sh` with
 * an existence guard rather than executed/relied-on directly.
 */
export function bootstrapHookCommand(event: string): HookCommand {
  const scriptRef = `\${CLAUDE_PROJECT_DIR}/${BOOTSTRAP_SCRIPT_RELPATH}`;
  return {
    type: "command",
    command: "sh",
    args: ["-c", 'test -f "$1" || exit 0; exec sh "$1" "$2"', "twing-bootstrap-hook", scriptRef, event],
  };
}

/** Recognises both shapes this hook has shipped in: v1-v3's inlined script
 * (marker as the command's first line) and v4+'s committed script file
 * (named in the arguments). See `enforce-hooks.ts`'s original comment. */
export function isBootstrapHook(hook: { command: string; args?: string[] }): boolean {
  if (KNOWN_BOOTSTRAP_HOOK_MARKERS.some((marker) => hook.command.startsWith(marker))) return true;
  return (hook.args ?? []).some((arg) => arg.endsWith(BOOTSTRAP_SCRIPT_RELPATH));
}

interface MarkedLocation {
  eventName: string;
  entryIndex: number;
  hookIndex: number;
}

/** Every bootstrap-hook entry present, any version, across every event. See
 * `enforce-hooks.ts`'s original comment for why this scans every event and
 * returns every match rather than just the first. */
function findMarkedEntries(settings: ClaudeSettings): MarkedLocation[] {
  const found: MarkedLocation[] = [];
  for (const eventName of Object.keys(settings.hooks ?? {})) {
    const entries = settings.hooks?.[eventName] ?? [];
    entries.forEach((entry, entryIndex) => {
      entry.hooks.forEach((hook, hookIndex) => {
        if (isBootstrapHook(hook)) found.push({ eventName, entryIndex, hookIndex });
      });
    });
  }
  return found;
}

/** Drops the located hooks, any matcher entry left with none, and any event
 * left with no entries. Removes back-to-front so earlier indices stay valid
 * as it goes. Another tool's hooks under the same matcher are untouched. */
function removeMarked(settings: ClaudeSettings, marked: MarkedLocation[]): void {
  for (const { eventName, entryIndex, hookIndex } of [...marked].reverse()) {
    settings.hooks?.[eventName]?.[entryIndex]?.hooks.splice(hookIndex, 1);
  }
  for (const eventName of Object.keys(settings.hooks ?? {})) {
    const entries = settings.hooks?.[eventName];
    if (!entries) continue;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].hooks.length === 0) entries.splice(i, 1);
    }
    if (entries.length === 0) delete settings.hooks?.[eventName];
  }
}

/** True if `settings` already has the bootstrap hook wired (any version, any
 * event -- checked by marker, not exact script equality). */
export function hasBootstrapHookWired(settings: ClaudeSettings): boolean {
  return findMarkedEntries(settings).length > 0;
}

/**
 * Merges the six bootstrap-hook entries into `settings` in place --
 * read-merge-write semantics, but purely in memory: the caller owns where
 * `settings` came from (local disk for `enforce-hooks.ts`, a GitHub Contents
 * API fetch for the App Setup URL route) and where it goes after. Existing
 * bootstrap entries of any version are removed first and the current set
 * appended, rather than upgraded in place -- see `enforce-hooks.ts`'s
 * original comment on `enableInstallEnforcement` for why. Returns true iff
 * `settings` was actually changed.
 */
export function mergeBootstrapHookEntries(settings: ClaudeSettings): boolean {
  const before = JSON.stringify(settings);
  settings.hooks ??= {};
  removeMarked(settings, findMarkedEntries(settings));

  for (const { event, matcher } of WIRED_HOOK_EVENTS) {
    const entries = (settings.hooks[event] ??= []);
    const existing = entries.find((e) => e.matcher === matcher);
    if (existing) {
      existing.hooks.push(bootstrapHookCommand(event));
    } else {
      const entry: HookMatcherEntry = { ...(matcher ? { matcher } : {}), hooks: [bootstrapHookCommand(event)] };
      entries.push(entry);
    }
  }

  return JSON.stringify(settings) !== before;
}

/** Inverse of `mergeBootstrapHookEntries`: removes twing's bootstrap hooks
 * -- every version, across every event -- from `settings` in place. Sibling
 * hooks under a shared matcher entry are preserved, and an entry is dropped
 * only once it is empty. Returns true iff anything was removed. */
export function removeBootstrapHookEntries(settings: ClaudeSettings): boolean {
  const marked = findMarkedEntries(settings);
  if (marked.length === 0) return false;
  removeMarked(settings, marked);
  return true;
}
