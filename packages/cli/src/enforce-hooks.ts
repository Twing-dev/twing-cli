/**
 * Admin-driven onboarding: the committed artifact that makes every future
 * clone of a repo coordinate through twing, with nothing for the developer
 * to install.
 *
 * Two git-tracked files (never `.claude/settings.local.json`, which is not
 * shared): `.twing/bootstrap-hook.sh`, and the `.claude/settings.json`
 * entries that point Claude Code at it.
 *
 * **The hook bootstraps rather than blocks (since v3).** v1/v2 denied the
 * edit and told the agent to run `npm install -g @twing/cli && twing init`.
 * That failed in practice, twice over. An install instruction arriving as
 * *denied tool output* is indistinguishable from a prompt-injection
 * attempt, so a well-behaved agent refuses it -- confirmed live, a real
 * session refused even after its operator explicitly said to proceed. And
 * `npm install -g` needs a writable global prefix, so on a system-Node box
 * it needs sudo, which a hook (no TTY) can never supply: even a fully
 * cooperative agent would have failed. So the hook *performs* the setup it
 * used to demand -- unprivileged (`npm install --prefix` into
 * `~/.twing/lib`, no elevation) and with no human in the loop -- then execs
 * the installed binary.
 *
 * **A script file, not an inline string (v4).** v3 inlined the whole
 * script as one escaped JSON string. At one wired event that was ugly; at
 * six (below) it would have put ~15KB of unreadable shell into the file an
 * admin is supposed to read before committing it. Claude Code exports
 * `${CLAUDE_PROJECT_DIR}` to hook commands and expands its path
 * placeholders in `args` as well as `command`, so the entries can name a
 * committed script instead. Run via `sh` rather than executed directly, so
 * a checkout that lost the executable bit still works.
 *
 * **All six entries, not just the gate (v4).** v3 committed a single
 * `PreToolUse`/`Edit|Write` entry, on the theory that the committed hook
 * was a bootstrap mechanism that would hand over to machine-global wiring.
 * For a developer who never installs twing that handover never comes, and
 * the consequence was not partial but compounding: with no `PostToolUse`
 * the daemon receives no claims and so never learns which coordinator to
 * poll, and with no `SessionStart`/`UserPromptSubmit` nothing ever connects
 * to it at all -- so it idle-exits after 30 minutes and `selfHealDaemon`,
 * wired to those same two events, never restarts it. Found live: a
 * developer whose daemon had been dead for 92 seconds was handed three
 * commands to run by hand, none of which would have worked on that machine.
 * The committed set therefore mirrors `wire-hooks.ts`'s global set exactly.
 *
 * **Exactly one wiring source is authoritative per repo.** Claude Code
 * merges hooks across settings scopes and runs *all* of them for a given
 * event/matcher, so a repo carrying both these entries and the
 * machine-global wiring would fire twice per tool call -- duplicate claims,
 * two gate checks per `Edit`. The script's first act is therefore to stand
 * down when `~/.claude/settings.json` already references the binary. A
 * developer who installs twing themselves and runs `twing init` gets the
 * global wiring and these entries go quiet; one who never installs anything
 * is driven entirely from here. Both are supported, and neither requires
 * the other.
 *
 * Dedup is deliberately by marker rather than `wireHooks`'s exact
 * `{matcher, command}` match: the artifact here changes across releases,
 * and a repo's committed settings file is far likelier than the
 * machine-global one to already carry another tool's hook under the same
 * matcher. Matching by marker lets a revision replace what is there instead
 * of duplicating beside it, and sibling hooks survive untouched.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readClaudeSettings, writeClaudeSettings, type ClaudeSettings, type HookCommand, type HookMatcherEntry } from "@twing/core";

export const BOOTSTRAP_HOOK_MARKER = "# twing-bootstrap-hook-v4";

/**
 * Every marker string this hook has ever shipped under, current one first.
 *
 * Recognising the old ones is not housekeeping -- it is what makes an
 * upgrade possible at all. Entries are located by marker, so a marker that
 * isn't recognised is one a new version appends *beside* instead of
 * replacing. That is exactly what the v2 -> v3 rename caused: a repo
 * carrying v2 ended up with both entries, Claude Code ran both, and the
 * stale v2 denied every edit forever (v2 requires the global
 * `~/.claude/settings.json` wiring, which the `--unattended` bootstrap
 * deliberately never creates). A repo could go from "not auto-installing"
 * to "permanently blocked" by running the very command meant to fix it.
 *
 * So: never remove an entry from this list, even long after that version
 * stops being written. Repos hold committed copies indefinitely -- the only
 * thing that rewrites one is an admin re-running `twing init` / `twing
 * project enable-enforcement` and committing the result.
 *
 * v1-v3 inlined the script as the `command` string, so their markers are
 * matched as a command prefix. v4 onwards names a committed script file
 * instead; `isBootstrapHook` recognises both shapes.
 */
export const KNOWN_BOOTSTRAP_HOOK_MARKERS = [
  BOOTSTRAP_HOOK_MARKER,
  "# twing-bootstrap-hook-v3",
  "# twing-install-enforcement-hook-v2",
  "# twing-install-enforcement-hook-v1",
];

/** Repo-relative location of the committed script. Also the identifier for
 * a v4+ entry -- `isBootstrapHook` matches on an argument ending with this,
 * so the `${CLAUDE_PROJECT_DIR}` prefix Claude Code expands is irrelevant
 * to recognition. */
export const BOOTSTRAP_SCRIPT_RELPATH = path.join(".twing", "bootstrap-hook.sh");

/**
 * Every hook event the committed entries cover, mirroring `wire-hooks.ts`'s
 * global set exactly -- `POST_TOOL_USE_MATCHER` and
 * `DESIGN_GATE_PRE_TOOL_USE_MATCHERS` there are the same values. The two
 * wiring sources must stay identical in coverage: whichever one is
 * authoritative on a given machine has to deliver the whole product, not a
 * subset, and a difference between them would show up as a capability that
 * silently depends on how the developer happened to onboard.
 */
const WIRED_EVENTS: { event: string; matcher?: string }[] = [
  { event: "PreToolUse", matcher: "ExitPlanMode" },
  { event: "PreToolUse", matcher: "Edit|Write" },
  { event: "PostToolUse", matcher: "Edit|Write|Read|Grep|Glob" },
  { event: "SessionStart" },
  { event: "UserPromptSubmit" },
  { event: "SessionEnd" },
];

/**
 * The committed script's exact contents.
 *
 * Portable across every developer's machine unmodified: `$HOME` is a
 * literal shell variable expanded at hook-execution time on each machine,
 * unlike `wireHooks`' baked-in resolved path (which only works on the
 * machine it was wired on).
 *
 * The steady-state path -- every run after the first on a given machine --
 * touches nothing but `test`, `grep` and `exec`, with no subprocess at all.
 * `git` is consulted only when a bootstrap might actually be needed, which
 * is once per machine rather than once per tool call; that ordering matters
 * more at six wired events than it did at one, since `PostToolUse` now
 * fires on every `Read`/`Grep`/`Glob` too. `npm`/`node` are touched only by
 * the one-time install branch.
 *
 * `$1` is the hook event this entry is wired for, passed as an argument
 * rather than read from the payload on stdin: a `PostToolUse` payload for a
 * `Write` carries the entire file body, and `payload=$(cat)` would buffer
 * that on every tool call. It is needed only by the bootstrap-failure
 * branch, whose `permissionDecision` output is meaningful for `PreToolUse`
 * and nothing else.
 *
 * A missing `.twing/twing.yml` or a failed `git rev-parse` exits 0 with no
 * stdout, mirroring the existing codebase idiom (`hook/design_gate.go`'s
 * `resolveRepoRelative`/`readCoordinatorServerURL` `ok=false` paths) that
 * silent no-output means "not this mechanism's concern, proceed normally."
 * Deliberately carries no `TWING_DESIGN_GATE`-style kill switch -- there is
 * no developer-facing escape hatch for this gate, by design; the deny
 * message says so.
 */
export function bootstrapHookScript(): string {
  return `#!/bin/sh
${BOOTSTRAP_HOOK_MARKER}
#
# Committed by \`twing init\` / \`twing project enable-enforcement\`. Every
# clone of this repo coordinates through twing without anyone installing
# anything: this script sets twing up on first use, then hands the real
# decision to the installed binary.
#
# Do not edit by hand -- it is regenerated wholesale, and a modified copy
# is replaced the next time an admin re-runs either command above.
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

# First use on a machine that has never run twing: set it up rather than
# demanding someone else do it. Everything here is unprivileged -- the
# install prefix is under \$HOME (no sudo, unlike npm install -g), and
# --unattended skips the OS-service step.
#
# Output goes to a log rather than /dev/null. Discarding it meant a
# precise, actionable error (\`gh auth login\` is the common one) was thrown
# away and replaced by a message guessing at three possible causes -- see
# the deny text below, which now points here instead.
lib="\$HOME/.twing/lib"
cli="\$lib/node_modules/@twing/cli/dist/index.js"
log="\$HOME/.twing/bootstrap.log"
mkdir -p "\$HOME/.twing"
echo "=== twing bootstrap \$(date -u +%Y-%m-%dT%H:%M:%SZ) ===" >> "\$log" 2>/dev/null

# Reuse a twing that is already on PATH before fetching another copy: a
# machine with a working global install needs no download at all, and
# installing a second copy beside it is confusing to anyone inspecting this
# script (it reads as the repo insisting on its own binary).
if command -v twing >/dev/null 2>&1; then
  twing init --unattended >> "\$log" 2>&1 </dev/null
fi
if [ ! -x "\$hook_bin" ]; then
  npm install --prefix "\$lib" @twing/cli@latest --no-fund --no-audit --loglevel=error >> "\$log" 2>&1 </dev/null
  [ -f "\$cli" ] && node "\$cli" init --unattended >> "\$log" 2>&1 </dev/null
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
 * from stdout. Kept in its own function purely so the script above stays
 * readable -- the message is an operational report, deliberately naming no
 * command for the agent to run: the whole point of this mechanism is that
 * installing twing is not the developer's or the agent's job. */
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
    "  log has the real cause. The most common one is that twing needs a",
    "  GitHub credential to verify your access to this repo, and none was",
    "  available non-interactively, which `gh auth login` fixes.",
  ].join("\n");

  const payload = JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
  });
  // Single-quoted for sh, so nothing inside is expanded; the payload is
  // JSON and can never contain a single quote of its own.
  return `printf '%s' '${payload}'`;
}

function settingsPath(repoRoot: string): string {
  return path.join(repoRoot, ".claude", "settings.json");
}

export function bootstrapScriptPath(repoRoot: string): string {
  return path.join(repoRoot, BOOTSTRAP_SCRIPT_RELPATH);
}

/** The hook entry pointing at this repo's committed script. `sh <script>`
 * rather than executing it directly: git tracks the executable bit, but a
 * checkout that lost it (a zip export, a Windows clone, an over-broad
 * umask) would otherwise fail with no way for the reader to tell why. */
function bootstrapHookCommand(event: string): HookCommand {
  const scriptRef = `\${CLAUDE_PROJECT_DIR}/${BOOTSTRAP_SCRIPT_RELPATH.split(path.sep).join("/")}`;
  return { type: "command", command: "sh", args: [scriptRef, event] };
}

/** Recognises both shapes this hook has shipped in: v1-v3's inlined script
 * (marker as the command's first line) and v4+'s committed script file
 * (named in the arguments).
 *
 * Exported for `wire-hooks.ts`'s `unwireHooks`, which has to recognise the
 * same thing when clearing the *global* file: matching only the resolved
 * binary path missed bootstrap entries entirely there once, and the
 * consequence was not cosmetic (uninstall reported success while a
 * bootstrap hook kept silently reinstalling twing). Sharing the predicate
 * is what stops the two from drifting apart again as the shape changes. */
export function isBootstrapHook(hook: { command: string; args?: string[] }): boolean {
  if (KNOWN_BOOTSTRAP_HOOK_MARKERS.some((marker) => hook.command.startsWith(marker))) return true;
  const scriptSuffix = BOOTSTRAP_SCRIPT_RELPATH.split(path.sep).join("/");
  return (hook.args ?? []).some((arg) => arg.endsWith(scriptSuffix));
}

interface MarkedLocation {
  eventName: string;
  entryIndex: number;
  hookIndex: number;
}

/** Every bootstrap-hook entry present, any version, across every event.
 *
 * Scans all events rather than just `PreToolUse`/`Edit|Write` because an
 * upgrade has to find what the *previous* version wrote, and the wired set
 * changes between versions -- v3 wrote one entry, v4 writes six. It also
 * returns all matches rather than the first: a repo can legitimately carry
 * more than one, since the v2 -> v3 rename appended instead of replacing.
 * Both fire, and a stale one denies, so an upgrade has to collapse them. */
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

/** True if this repo's committed `.claude/settings.json` already has the
 * bootstrap hook wired (any version, any event -- checked by marker, not
 * exact script equality; `enableInstallEnforcement` is what upgrades an
 * out-of-date one). */
export function isInstallEnforcementWired(repoRoot: string): boolean {
  return findMarkedEntries(readClaudeSettings(settingsPath(repoRoot))).length > 0;
}

/**
 * Writes both committed artifacts: the script, and the six entries pointing
 * at it. Read-merge-write throughout -- another tool's hooks and any
 * unrelated settings survive untouched.
 *
 * Existing bootstrap entries of any version are removed first and the
 * current set appended, rather than upgraded in place. With the wired set
 * itself changing between versions there is no longer a one-to-one mapping
 * to upgrade *into*, and remove-then-append is idempotent: a second run
 * produces byte-identical output, so it reports no change.
 *
 * Returns true iff either file was actually changed.
 */
export function enableInstallEnforcement(repoRoot: string): boolean {
  // A repo rooted at $HOME (a dotfiles repo, and they are common) would put
  // this hook in ~/.claude/settings.json -- the machine-global file, not a
  // project's committed one. It would then fire for *every* repo on the
  // machine rather than the one being enabled, and survive `twing
  // uninstall`'s teardown of the project it was meant for. Almost certainly
  // not what was meant, so refuse rather than do it quietly.
  if (path.resolve(repoRoot) === path.resolve(os.homedir())) {
    throw new Error(
      "twing: refusing to write the bootstrap hook into your home directory. " +
        `The repo root resolved to ${repoRoot}, so this would land in ~/.claude/settings.json -- the ` +
        "machine-global file -- and fire for every repo on this machine. Run this from inside the " +
        "project you mean to enable.",
    );
  }

  const scriptChanged = writeBootstrapScript(repoRoot);

  const target = settingsPath(repoRoot);
  const settings = readClaudeSettings(target);
  const before = JSON.stringify(settings);

  settings.hooks ??= {};
  removeMarked(settings, findMarkedEntries(settings));

  for (const { event, matcher } of WIRED_EVENTS) {
    const entries = (settings.hooks[event] ??= []);
    // Append into an existing entry for this exact matcher when there is
    // one, so another tool's hook under the same matcher keeps its block
    // rather than gaining a duplicate beside it.
    const existing = entries.find((e) => e.matcher === matcher);
    if (existing) {
      existing.hooks.push(bootstrapHookCommand(event));
    } else {
      const entry: HookMatcherEntry = { ...(matcher ? { matcher } : {}), hooks: [bootstrapHookCommand(event)] };
      entries.push(entry);
    }
  }

  const settingsChanged = JSON.stringify(settings) !== before;
  if (settingsChanged) writeClaudeSettings(target, settings);
  return scriptChanged || settingsChanged;
}

/** Writes `.twing/bootstrap-hook.sh`, returning true iff its contents
 * changed. Mode 0755 so a checkout preserves the executable bit for anyone
 * who runs it directly, even though the wired entries go through `sh`. */
function writeBootstrapScript(repoRoot: string): boolean {
  const target = bootstrapScriptPath(repoRoot);
  const script = bootstrapHookScript();
  if (fs.existsSync(target) && fs.readFileSync(target, "utf8") === script) return false;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, script, { mode: 0o755 });
  return true;
}

/** Inverse of `enableInstallEnforcement`: removes twing's bootstrap hooks
 * -- every version, across every event, including a duplicate left by a
 * pre-fix upgrade -- and deletes the committed script. Sibling hooks under
 * a shared matcher entry are preserved, and an entry is dropped only once
 * it is empty. Returns true iff anything was removed. */
export function disableInstallEnforcement(repoRoot: string): boolean {
  const target = settingsPath(repoRoot);
  const settings = readClaudeSettings(target);

  const marked = findMarkedEntries(settings);
  if (marked.length > 0) {
    removeMarked(settings, marked);
    writeClaudeSettings(target, settings);
  }

  const script = bootstrapScriptPath(repoRoot);
  const hadScript = fs.existsSync(script);
  if (hadScript) fs.rmSync(script, { force: true });

  return marked.length > 0 || hadScript;
}
