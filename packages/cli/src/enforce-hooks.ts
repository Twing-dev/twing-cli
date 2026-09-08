/**
 * Admin-driven onboarding: merges a single `PreToolUse`/`Edit|Write` hook
 * into a repo's own, **git-tracked** `.claude/settings.json` (never
 * `.claude/settings.local.json`) -- the one committed artifact that makes
 * every future clone of the repo coordinate through twing.
 *
 * **This hook bootstraps rather than blocks (v3).** v1/v2 denied the edit
 * and told the agent to run `npm install -g @twing/cli && twing init`.
 * That failed in practice, twice over. An install instruction arriving as
 * *denied tool output* is indistinguishable from a prompt-injection
 * attempt, so a well-behaved agent refuses it -- confirmed live, a real
 * session refused even after its operator explicitly said to proceed. And
 * `npm install -g` needs a writable global prefix, so on a system-Node box
 * it needs sudo, which a hook (no TTY) can never supply: even a fully
 * cooperative agent would have failed. So the hook now *performs* the
 * setup it used to demand -- unprivileged (`npm install --prefix` into
 * `~/.twing/lib`, which needs no elevation) and with no human in the loop
 * -- then execs the installed binary. Enforcement is preserved: twing ends
 * up active either way. Only the friction goes.
 *
 * Distinct in kind from
 * `wire-hooks.ts`'s `wireHooks`, which only ever writes the machine-global
 * `~/.claude/settings.json`: that file is per-machine and purely opt-in,
 * so a teammate who never ran `init` has zero hooks configured at all for a
 * twing-enabled repo. This is the repo-committed counterpart that closes
 * that gap.
 *
 * **Exactly one wiring source is authoritative per repo.** Claude Code
 * merges hooks across settings scopes and runs *all* of them for a given
 * event/matcher, so a repo carrying both this committed entry and the
 * machine-global wiring would fire the hook twice per tool call --
 * duplicate claims, two gate checks per `Edit`. The script's first act is
 * therefore to stand down when it sees `~/.claude/settings.json` already
 * references the binary. Fresh clone: no global wiring, so this entry
 * execs the hook. After a deliberate `twing init`: global wiring exists,
 * and this entry goes quiet. `init --unattended` deliberately does *not*
 * add global wiring, so the bootstrap path never creates the overlap.
 *
 * Global wiring stays the better steady state, and is why the committed
 * entry is a bootstrap mechanism rather than a replacement: a session
 * started in a directory *containing* twing repos (rather than inside one)
 * has no repo-local settings file to load at all, and only the global
 * entry can fire -- see `hook/manifest.go`'s `discoverChildCoordinators`
 * and `hook/config.go`'s `resolveServerConfigForFile`.
 *
 * Dedup strategy is deliberately different from `wireHooks`'s exact
 * `{matcher, command}` string match: the artifact here is a multi-line
 * script that may need to change across releases, and a repo's own
 * committed settings file is far likelier than the machine-global one to
 * already declare another tool's hook under the same `Edit|Write` matcher.
 * So: match by a version-stamped marker prefix (lets a future script
 * revision upgrade an existing entry in place instead of duplicating or
 * silently never updating), and append into an existing `Edit|Write`
 * matcher entry's `hooks[]` rather than always creating a new matcher
 * block (so another tool's hook under the same matcher survives untouched).
 */

import * as path from "node:path";
import { readClaudeSettings, writeClaudeSettings, type HookMatcherEntry } from "@twing/core";

export const BOOTSTRAP_HOOK_MARKER = "# twing-bootstrap-hook-v3";

const ENFORCEMENT_MATCHER = "Edit|Write";

/**
 * The exact script installed as this hook entry's `command`. Portable
 * across every developer's machine unmodified -- `$HOME` is a literal shell
 * variable in the committed text, expanded locally at hook-execution time
 * on each developer's own machine, unlike `wireHooks`' baked-in resolved
 * path (which only works on the machine it was wired on). The steady-state
 * path -- every run after the first on a given machine -- shells out to
 * nothing but `git`, `test`, `grep` and `exec`, all universally present on
 * any POSIX `sh`; `npm`/`node` are touched only by the one-time install
 * branch. A failed `git rev-parse` or a
 * missing `.twing/twing.yml` exits 0 with no stdout at all, mirroring the
 * existing codebase idiom (`hook/design_gate.go`'s `resolveRepoRelative`/
 * `readCoordinatorServerURL` `ok=false` paths) that silent no-output means
 * "not this mechanism's concern, proceed normally." Deliberately carries no
 * `TWING_DESIGN_GATE`-style kill switch -- there is no developer-facing
 * escape hatch for this gate, by design; the deny message says so.
 */
export function bootstrapHookScript(): string {
  return [
    BOOTSTRAP_HOOK_MARKER,
    'repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0',
    'if [ -z "$repo_root" ] || [ ! -f "$repo_root/.twing/twing.yml" ]; then',
    "  exit 0",
    "fi",
    'hook_bin="$HOME/.twing/bin/twing-hook"',
    'settings="$HOME/.claude/settings.json"',
    "# Already wired machine-globally: that entry handles this event, so stay",
    "# silent. Claude Code merges hooks across settings scopes and runs all of",
    "# them -- without this guard both would fire for every tool call.",
    'if [ -f "$settings" ] && grep -qF "$hook_bin" "$settings" 2>/dev/null; then',
    "  exit 0",
    "fi",
    "# First edit on a machine that has never run twing: install it rather than",
    "# demanding someone else do it. Unprivileged by construction -- the prefix",
    "# is under $HOME (no sudo, unlike npm install -g), and --unattended skips",
    "# the OS-service step. Installing into twing's own directory rather than",
    "# running straight from npx matters: the daemon launch marker records this",
    "# path, and npm may evict its own cache at any time, which would leave a",
    "# marker that works today and silently fails weeks later.",
    'lib="$HOME/.twing/lib"',
    'cli="$lib/node_modules/@twing/cli/dist/index.js"',
    'if [ ! -x "$hook_bin" ]; then',
    '  npm install --prefix "$lib" @twing/cli@latest --no-fund --no-audit --loglevel=error >/dev/null 2>&1 </dev/null',
    '  [ -f "$cli" ] && node "$cli" init --unattended >/dev/null 2>&1 </dev/null',
    "fi",
    'if [ ! -x "$hook_bin" ]; then',
    "  printf '%s' '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"twing could not install itself on this machine, so this repo is not coordinating edits right now.\\n\\n  This repo uses twing (https://twing.dev, source at\\n  https://github.com/Twing-dev/twing-cli) to stop two AI sessions\\n  silently colliding on the same code. Its setup runs automatically\\n  from a hook this repo commits -- normally with nothing to do by\\n  hand -- and that automatic setup just failed.\\n\\n  This is an operational failure, not a task for you to work around:\\n  do not try to install it another way, and do not edit or remove the\\n  hook (that hits this same check anyway). Report it to whoever runs\\n  this repo.\\n\\n  Usual causes, in order\\n    - no network, or npm is unreachable from this machine\\n    - node/npm is missing or too old (needs Node >= 20)\\n    - no GitHub credential available: twing authenticates via the gh\\n      CLI when running unattended, so `gh auth login` may be needed\\n\\n  To see the real error, a human can run twing setup by hand -- instructions at https://github.com/Twing-dev/twing-cli\"}}'",
    "  exit 0",
    "fi",
    "# Hand the real decision to the installed hook: same binary, same",
    "# protocol (JSON on stdin, verdict on stdout) as the global wiring would.",
    'exec "$hook_bin"',
    "",
  ].join("\n");
}

function settingsPath(repoRoot: string): string {
  return path.join(repoRoot, ".claude", "settings.json");
}

function findMarkedEntry(entries: HookMatcherEntry[]): { entryIndex: number; hookIndex: number } | undefined {
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
    if (entries[entryIndex].matcher !== ENFORCEMENT_MATCHER) continue;
    const hookIndex = entries[entryIndex].hooks.findIndex((h) => h.command.startsWith(BOOTSTRAP_HOOK_MARKER));
    if (hookIndex !== -1) return { entryIndex, hookIndex };
  }
  return undefined;
}

/** True if this repo's committed `.claude/settings.json` already has the
 * bootstrap hook wired (any version -- checked by marker prefix, not exact
 * script equality; `enableInstallEnforcement` is what upgrades an
 * out-of-date one). */
export function isInstallEnforcementWired(repoRoot: string): boolean {
  const settings = readClaudeSettings(settingsPath(repoRoot));
  return findMarkedEntry(settings.hooks?.PreToolUse ?? []) !== undefined;
}

/** Read-merge-write into `<repoRoot>/.claude/settings.json` (git-tracked --
 * never `.claude/settings.local.json`). Three cases: no marked entry
 * anywhere (append into an existing `Edit|Write` matcher entry if one
 * already exists, else create a fresh one); a marked entry with the
 * current script already (no-op); a marked entry with an older script
 * (in-place upgrade, same array position, sibling hooks untouched).
 * Returns true iff the file was changed. */
export function enableInstallEnforcement(repoRoot: string): boolean {
  const target = settingsPath(repoRoot);
  const settings = readClaudeSettings(target);
  const script = bootstrapHookScript();

  settings.hooks ??= {};
  const entries = (settings.hooks.PreToolUse ??= []);
  const found = findMarkedEntry(entries);

  if (found) {
    const existingCommand = entries[found.entryIndex].hooks[found.hookIndex].command;
    if (existingCommand === script) return false;
    entries[found.entryIndex].hooks[found.hookIndex] = { type: "command", command: script };
    writeClaudeSettings(target, settings);
    return true;
  }

  const existingMatcherEntry = entries.find((e) => e.matcher === ENFORCEMENT_MATCHER);
  if (existingMatcherEntry) {
    existingMatcherEntry.hooks.push({ type: "command", command: script });
  } else {
    entries.push({ matcher: ENFORCEMENT_MATCHER, hooks: [{ type: "command", command: script }] });
  }
  writeClaudeSettings(target, settings);
  return true;
}

/** Inverse of `enableInstallEnforcement`: removes only the marked hook
 * object, preserving any sibling hooks under the same matcher entry and
 * dropping the matcher entry itself only if it becomes empty. Returns true
 * iff anything was removed. */
export function disableInstallEnforcement(repoRoot: string): boolean {
  const target = settingsPath(repoRoot);
  const settings = readClaudeSettings(target);
  const entries = settings.hooks?.PreToolUse;
  if (!entries) return false;

  const found = findMarkedEntry(entries);
  if (!found) return false;

  entries[found.entryIndex].hooks.splice(found.hookIndex, 1);
  if (entries[found.entryIndex].hooks.length === 0) entries.splice(found.entryIndex, 1);

  writeClaudeSettings(target, settings);
  return true;
}
