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
import { getCliVersion } from "./version.js";
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
 * and `payload=$(cat)` would buffer that on every tool call. The install
 * branch does read the payload, once, for the one event that can act on it --
 * see the comment on `start_dir` below.
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
hook_stamp="\$HOME/.twing/bin/twing-hook.version"
twing_upgrade_dir="\$HOME/.twing/bin/upgrade-attempts"

# The version of the CLI that generated this script. The binary beside it
# records which CLI installed *it* (install-hook.ts's stamp), and the two
# disagreeing means an upgrade replaced the CLI, this resolver and the Codex
# launcher while leaving the binary they hand events to behind.
#
# That is not hypothetical: it was found on a real machine running a 1.2.1
# CLI with a binary from eight days earlier, where every Codex edit was
# silently allowed because that binary has no case for \`apply_patch\`. Claude
# Code repairs itself there -- its edits reach the gate, the gate sees a
# version mismatch and recovers -- but the Codex path cannot, because the
# case it is missing *is* the gate path. So the check has to happen before
# the binary runs, which is here.
twing_expected_version="${getCliVersion()}"

# This repo commits its own twing hook and Claude Code has loaded it, so that
# entry is already handling this event. Claude Code runs every matching hook
# in parallel across settings scopes, so both would otherwise do the work --
# two gate checks per edit. Stand down.
#
# Matches older inlined markers too: a repo may still carry a v1-v3 committed
# hook, which covers this session just as well.
#
# Claude Code only. Every other harness reaches this script through its own
# launcher, which says which one it is (TWING_HARNESS) -- and none of them
# reads .claude/settings.json, so a committed Claude hook covers nothing
# there and this entry is the only one running. Phrased as "no harness
# named" rather than a list of the ones to skip, so a harness added later is
# correct here by default instead of standing down into silence.
proj="\${CLAUDE_PROJECT_DIR:-\$PWD}"
if [ -z "\${TWING_HARNESS:-}" ] && \\
   grep -qE 'bootstrap-hook\\.sh|twing-bootstrap-hook|twing-install-enforcement-hook' \\
     "\$proj/.claude/settings.json" 2>/dev/null; then
  exit 0
fi

# Steady state: hand the event over with cwd untouched, so the binary resolves
# the coordinator from the file being edited rather than from where Claude
# happened to start.
#
# \`read\` rather than \`cat\`: a builtin, so the common path still costs no
# subprocess.
twing_installed_version=""
if [ -f "\$hook_stamp" ]; then
  read -r twing_installed_version < "\$hook_stamp" 2>/dev/null || twing_installed_version=""
fi

twing_stale=""
if [ -x "\$hook_bin" ] && [ "\$twing_installed_version" != "\$twing_expected_version" ]; then
  twing_stale=1
fi

if [ -x "\$hook_bin" ] && [ -z "\$twing_stale" ]; then
  exec "\$hook_bin"
fi

# Either nothing is installed, or what is installed is older than this
# script. Both are handled by the install branch below -- and both fall back
# to running whatever binary *is* there (twing_fallback), because a stale
# hook still gates Claude Code correctly and refusing to run it would trade
# one silent gap for a wider one.
twing_fallback() {
  if [ -x "\$hook_bin" ]; then
    if [ -n "\$payload_saved" ]; then
      exec "\$hook_bin" <&3
    fi
    exec "\$hook_bin"
  fi
  exit 0
}

# Nothing installed yet. Only these two events may install: Claude Code lowers
# the hook timeout to 30s on UserPromptSubmit and *discards* the output of a
# hook that overruns, so an npm install attempted there would silently do
# nothing. SessionStart and PreToolUse keep the 600s default.
case "\$twing_event" in
  SessionStart|PreToolUse) ;;
  *) twing_fallback ;;
esac

# Where to start looking for the repo to install *for*.
#
# cwd is the obvious answer and wrong on its own. Claude Code reads no
# settings above the session's own directory, so the sessions this resolver
# exists for are exactly the ones started *outside* a repo -- \`cd ~/work &&
# claude\`, then edit a file in a repo below. Walking up from ~/work finds no
# manifest, installs nothing, and every edit in that session goes ungated,
# silently, for the life of the session.
#
# On PreToolUse the payload names the file about to be edited, and that is the
# one anchor pointing *into* the repo. Two spellings of that anchor: Claude
# Code (and OpenCode, through twing's adapter) send \`tool_input.file_path\`,
# while Codex sends \`tool_input.command\` holding an apply_patch envelope
# whose targets are named inside it. Reading only the first meant a Codex
# session started outside a repo installed nothing and stayed ungated for its
# whole life -- exactly the failure this extraction exists to prevent. It costs a buffer of the whole payload,
# so it happens here and only here: after the steady-state exec above (every
# event once installed, stdin untouched), and only for the event that both
# carries a path and is allowed to install.
#
# Buffered to a file, never to a variable: the payload carries the file's full
# new contents, so command substitution would hold megabytes in the shell and
# mangle any NUL along the way. mktemp creates it 0600; it is read back on
# fd 3 and unlinked at once, so the contents outlive the name only for us. The
# binary is then fed from that fd, because stdin itself is spent by the time
# it runs.
start_dir=\$(pwd -P)
payload_saved=""
if [ "\$twing_event" = "PreToolUse" ] && command -v node >/dev/null 2>&1; then
  payload_file=\$(mktemp "\${TMPDIR:-/tmp}/twing-payload.XXXXXX" 2>/dev/null) || payload_file=""
  if [ -n "\$payload_file" ]; then
    cat > "\$payload_file"
    # node, not sed: the payload is JSON whose *content* may itself contain
    # the text \`"file_path":\` (editing a file that mentions it -- this script,
    # for one), and a pattern match cannot tell the field from the body.
    # Parsing costs nothing new here: the install below needs node anyway.
    edited_dirs=\$(node -e 'const out=[];const add=(f)=>{if(typeof f==="string"&&f!==""){out.push(require("path").dirname(require("path").resolve(f)));}};try{const p=JSON.parse(require("fs").readFileSync(0,"utf8"));const i=(p&&p.tool_input)||{};add(i.file_path);if(typeof i.command==="string"){let env=false;for(const line of i.command.split("\\n")){if(line.startsWith("***"))env=true;for(const mk of ["*** Add File:","*** Update File:","*** Delete File:","*** Move to:"]){if(line.startsWith(mk)){add(line.slice(mk.length).trim());}}if(!env&&line.startsWith("+++ ")){add(line.slice(4).replace(/^b\\//,"").trim());}}}}catch(e){}process.stdout.write(out.join("\\n"));' < "\$payload_file" 2>/dev/null)
    twing_session=\$(node -e 'let s="";try{const p=JSON.parse(require("fs").readFileSync(0,"utf8"));if(typeof p.session_id==="string")s=p.session_id.replace(/[^A-Za-z0-9._-]/g,"_");}catch(e){}process.stdout.write(s);' < "\$payload_file" 2>/dev/null)
    exec 3< "\$payload_file"
    rm -f "\$payload_file"
    payload_saved=1
    [ -n "\$edited_dirs" ] && start_dir="\$edited_dirs"
  fi
fi

# A stale binary gets at most one upgrade attempt per session on the edit
# path.
#
# It cannot be SessionStart-only, which is where this started: a session
# opened outside any repo (\`cd ~/work && codex\`) identifies no repo at
# SessionStart, so a restriction to that event means the upgrade never
# happens at all, and under Codex a pre-\`apply_patch\` binary then silently
# allows every edit of that session -- the exact failure this check exists to
# catch. The repo only becomes identifiable when an edit names a file, so the
# attempt has to be allowed here.
#
# It also cannot be *every* edit: on an offline machine, or one whose
# coordinator is down, that pays the installer's timeout before every edit
# for the life of the session. So the session id -- which the payload above
# just gave us -- bounds it to one attempt, after which this session gates
# with the binary it has. A session twing cannot identify does not attempt at
# all; SessionStart remains its route.
#
# One file per session rather than one file naming the last session: two
# sessions editing in turn would otherwise overwrite each other's marker and
# both retry on every edit, which is the cost this bound exists to avoid.
# Nothing accumulates in practice -- the moment an upgrade succeeds the stamp
# matches and this branch is never reached again, so the directory only grows
# while a machine is both stale and failing to fix itself.
if [ -n "\$twing_stale" ] && [ "\$twing_event" = "PreToolUse" ]; then
  [ -n "\$twing_session" ] || twing_fallback
  [ -f "\$twing_upgrade_dir/\$twing_session" ] && twing_fallback
fi

# Find a twing repo to install *for*: the coordinator decides which version to
# install, so there is nothing to do until one is identified. Walk up rather
# than asking git -- cheaper, and it works the same in a worktree. A directory
# that does not exist yet (a Write creating one) simply matches nothing on the
# way up.
#
# Every candidate the payload named, in the order it named them, until one is
# inside a twing repo. One is not enough: a Codex patch can add a file
# somewhere unmanaged while updating a managed repo in the same call, and
# stopping at the first target would resolve no coordinator and install
# nothing -- letting the whole patch through ungated. Caught in review before
# it shipped.
repo_root=""
twing_old_ifs=\$IFS
IFS='
'
for _cand in \$start_dir; do
  IFS=\$twing_old_ifs
  [ -n "\$_cand" ] || continue
  _d="\$_cand"
  while : ; do
    if [ -f "\$_d/.twing/twing.yml" ]; then
      repo_root="\$_d"
      break
    fi
    [ "\$_d" = "/" ] && break
    _d=\$(dirname "\$_d")
  done
  [ -n "\$repo_root" ] && break
  IFS='
'
done
IFS=\$twing_old_ifs
[ -n "\$repo_root" ] || twing_fallback

# Now, and not before: the attempt is recorded once there is something to
# install *for*. Recording it earlier spent the session's one attempt on an
# edit that named no managed repo -- a scratch file in /tmp, say -- and the
# next edit, the one actually inside a twing repo, fell straight through to
# the stale binary. Which is the failure this whole branch exists to prevent,
# reintroduced one line too early. Caught in review.
if [ -n "\$twing_stale" ] && [ "\$twing_event" = "PreToolUse" ] && [ -n "\$twing_session" ]; then
  mkdir -p "\$twing_upgrade_dir" 2>/dev/null || true
  : > "\$twing_upgrade_dir/\$twing_session" 2>/dev/null || true
fi
${coordinatorInstallShell()}

# A repo that wants twing, on a machine that cannot run it.
#
# Distinguish this from the silent \`exit 0\`s above, which all mean "nothing
# to gate here" -- no repo, no coordinator, an event that cannot install.
# This one means the opposite: there *is* something to gate, and we have just
# determined the machine cannot do it. Falling through to the same silent
# allow would leave the session ungated for its whole life with no signal
# anywhere, which is the failure this whole script exists to prevent.
if ! twing_node_ok; then
  twing_node_unusable
  twing_fallback
fi

twing_install_for_repo "\$repo_root"

# <&3 only when we consumed stdin above; otherwise it is still the payload.
twing_fallback
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
