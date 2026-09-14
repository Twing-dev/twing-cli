/**
 * Machine-wide wiring, for sessions that never load a repo's committed file.
 *
 * Claude Code reads a project's `.claude/settings.json` from the session's
 * **primary working directory** only -- no upward traversal, no scanning of
 * subdirectories. So a repo's committed hook fires when you start Claude
 * exactly at the repo root, and not otherwise:
 *
 *   cd ~/work && claude            -> parent has no .claude, nothing fires
 *   cd repo/packages/api && claude -> a *subdirectory* misses it too
 *
 * On a machine that never ran `twing init` by hand, those sessions are
 * completely unguarded: edits ungated, nothing captured, no notices, no
 * daemon revived, and no signal to the admin who committed the hook.
 *
 * `twing init --ghuser` (ghuser.ts) closes that by wiring this resolver into
 * the user-level `~/.claude/settings.json`, which is read regardless of where
 * a session starts.
 *
 * **Why a separate thin script rather than `wireHooks`' entries.** Wiring the
 * binary directly would mean a global `npm install -g`, which makes
 * `managedInstall()` false and so deliberately opts the machine *out* of
 * version recovery -- installing twing for better coverage would buy worse
 * version handling. This keeps the machine managed. And the settings entry
 * stays a fixed pointer, so the logic it points at can change with the
 * package rather than needing every developer to re-run a command.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  readClaudeSettings,
  writeClaudeSettings,
  WIRED_HOOK_EVENTS,
  coordinatorInstallShell,
  type ClaudeSettings,
  type HookCommand,
} from "@twing/core";

export const RESOLVER_MARKER = "# twing-resolver-v1";

/** Every marker this resolver has shipped under, current first. Same rule as
 * `KNOWN_BOOTSTRAP_HOOK_MARKERS`: never remove one. A marker that isn't
 * recognised is an entry a new version appends *beside* instead of replacing,
 * and two of these firing means two gate checks per edit. */
export const KNOWN_RESOLVER_MARKERS = [RESOLVER_MARKER];

export function resolverPath(): string {
  return path.join(os.homedir(), ".twing", "bin", "twing-resolve");
}

/**
 * The resolver script.
 *
 * The steady-state path -- every event once twing is installed -- is two
 * `test`s, a `grep` and an `exec`, with no subprocess and no network. The
 * install branch below it runs at most once per machine.
 *
 * `$1` is the hook event, passed as an argument rather than read from the
 * payload: a `PostToolUse` payload for a `Write` carries the whole file body,
 * and `payload=$(cat)` would buffer that on every tool call.
 */
export function resolverScript(): string {
  return `#!/bin/sh
${RESOLVER_MARKER}
#
# Written by \`twing init --ghuser\`. Do not edit by hand -- it is regenerated
# wholesale, and ships with @twing/cli so it updates with the package.
#
# $1 is the Claude Code hook event this entry is wired for.

twing_event="\$1"
hook_bin="\$HOME/.twing/bin/twing-hook"

# This repo commits its own twing hook and Claude Code has loaded it, so that
# entry is already handling this event. Claude Code runs every matching hook
# in parallel across settings scopes, so both would otherwise do the work --
# two gate checks per edit. Stand down.
#
# Matches older inlined markers too: a repo may still carry a v1-v3 committed
# hook, which covers this session just as well.
proj="\${CLAUDE_PROJECT_DIR:-\$PWD}"
if grep -qE 'bootstrap-hook\\.sh|twing-bootstrap-hook|twing-install-enforcement-hook' \\
     "\$proj/.claude/settings.json" 2>/dev/null; then
  exit 0
fi

# Steady state: hand the event over with cwd untouched, so the binary resolves
# the coordinator from the file being edited rather than from where Claude
# happened to start.
if [ -x "\$hook_bin" ]; then
  exec "\$hook_bin"
fi

# Nothing installed yet. Only these two events may install: Claude Code lowers
# the hook timeout to 30s on UserPromptSubmit and *discards* the output of a
# hook that overruns, so an npm install attempted there would silently do
# nothing. SessionStart and PreToolUse keep the 600s default.
case "\$twing_event" in
  SessionStart|PreToolUse) ;;
  *) exit 0 ;;
esac

# Find a twing repo to install *for*: the coordinator decides which version to
# install, so there is nothing to do until one is identified. Walk up from cwd
# rather than asking git -- cheaper, and it works the same in a worktree.
repo_root=""
_d=\$(pwd -P)
while : ; do
  if [ -f "\$_d/.twing/twing.yml" ]; then
    repo_root="\$_d"
    break
  fi
  [ "\$_d" = "/" ] && break
  _d=\$(dirname "\$_d")
done
[ -n "\$repo_root" ] || exit 0
${coordinatorInstallShell()}
twing_install_for_repo "\$repo_root"

if [ -x "\$hook_bin" ]; then
  exec "\$hook_bin"
fi
exit 0
`;
}

/**
 * One wired entry: a fixed pointer at the script, guarded by its own
 * existence.
 *
 * The guard is load-bearing. `sh` exits 2 when it cannot open the script, and
 * Claude Code treats exit 2 on `PreToolUse` as a **block** -- so a deleted
 * `~/.twing` would stop every edit in every repo with a raw shell error naming
 * no fix. Verified live. Without the guard this is a machine-wide outage
 * waiting on `rm -rf ~/.twing`.
 *
 * The path is resolved absolutely rather than written as `$HOME/...`: these
 * arguments are passed to `sh` verbatim by Claude Code, with no shell in
 * between to expand anything.
 */
function resolverEntry(event: string): HookCommand {
  return {
    type: "command",
    command: "sh",
    args: ["-c", 'test -f "$1" || exit 0; exec sh "$1" "$2"', "twing-resolver", resolverPath(), event],
  };
}

/** Recognises a resolver entry, for replacement and for `twing uninstall`. */
export function isResolverHook(hook: { command: string; args?: string[] }): boolean {
  return (hook.args ?? []).some((arg) => arg === resolverPath() || arg.endsWith(`${path.sep}twing-resolve`));
}

/** Drops every resolver entry, and any entry or event left empty. */
function removeResolverEntries(settings: ClaudeSettings): void {
  for (const eventName of Object.keys(settings.hooks ?? {})) {
    const entries = settings.hooks?.[eventName];
    if (!entries) continue;
    for (const entry of entries) {
      entry.hooks = entry.hooks.filter((h) => !isResolverHook(h));
    }
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].hooks.length === 0) entries.splice(i, 1);
    }
    if (entries.length === 0) delete settings.hooks?.[eventName];
  }
}

/**
 * Writes the script and the entries into `~/.claude/settings.json`.
 *
 * Removes any existing resolver entries first rather than merging, so a
 * change to the wired event set replaces the old set instead of accumulating
 * beside it -- the failure the v2 -> v3 bootstrap marker rename caused, where
 * both entries fired and the stale one denied everything.
 *
 * Returns true if anything changed, so callers can stay quiet when there was
 * nothing to do.
 */
export function writeResolverWiring(settingsPath: string): boolean {
  const script = resolverScript();
  const target = resolverPath();
  let scriptChanged = false;
  if (!fs.existsSync(target) || fs.readFileSync(target, "utf8") !== script) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, script, { mode: 0o755 });
    scriptChanged = true;
  }

  const settings = readClaudeSettings(settingsPath);
  const before = JSON.stringify(settings);
  settings.hooks ??= {};
  removeResolverEntries(settings);

  for (const { event, matcher } of WIRED_HOOK_EVENTS) {
    const entries = (settings.hooks[event] ??= []);
    const existing = entries.find((e) => e.matcher === matcher);
    if (existing) {
      existing.hooks.push(resolverEntry(event));
    } else {
      entries.push({ ...(matcher ? { matcher } : {}), hooks: [resolverEntry(event)] });
    }
  }

  const settingsChanged = JSON.stringify(settings) !== before;
  if (settingsChanged) writeClaudeSettings(settingsPath, settings);
  return scriptChanged || settingsChanged;
}

/** True if this machine is resolver-managed -- i.e. `--ghuser` was run. What
 * `init --unattended` checks before refreshing the wiring, so the refresh is
 * a strict no-op everywhere else. */
export function isResolverWired(settingsPath: string): boolean {
  const settings = readClaudeSettings(settingsPath);
  return Object.values(settings.hooks ?? {}).some((entries) => entries.some((e) => e.hooks.some((h) => isResolverHook(h))));
}

/** Inverse of `writeResolverWiring`, for `twing uninstall`. */
export function removeResolverWiring(settingsPath: string): boolean {
  const settings = readClaudeSettings(settingsPath);
  const before = JSON.stringify(settings);
  removeResolverEntries(settings);
  const changed = JSON.stringify(settings) !== before;
  if (changed) writeClaudeSettings(settingsPath, settings);

  const script = resolverPath();
  const hadScript = fs.existsSync(script);
  if (hadScript) fs.rmSync(script, { force: true });
  return changed || hadScript;
}
