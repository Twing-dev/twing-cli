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

import * as os from "node:os";
import * as path from "node:path";
import { readClaudeSettings, writeClaudeSettings, type HookMatcherEntry } from "@twing/core";

export const BOOTSTRAP_HOOK_MARKER = "# twing-bootstrap-hook-v3";

/**
 * Every marker string this hook has ever shipped under, current one first.
 *
 * Recognising the old ones is not housekeeping -- it is what makes an
 * upgrade possible at all. `enableInstallEnforcement` finds the entry to
 * replace by marker, so a marker it doesn't recognise is one it appends
 * *beside* instead of replacing. That is exactly what the v2 -> v3 rename
 * caused: a repo carrying v2 ended up with both entries, Claude Code ran
 * both, and the stale v2 denied every edit forever (v2 requires the global
 * `~/.claude/settings.json` wiring, which v3's `--unattended` bootstrap
 * deliberately never creates). A repo could go from "not auto-installing"
 * to "permanently blocked" by running the very command meant to fix it.
 *
 * So: never remove an entry from this list, even long after that version
 * stops being written. Repos hold committed copies indefinitely -- the only
 * thing that rewrites one is an admin re-running `twing init`/`twing
 * project enable-enforcement` and committing the result.
 */
export const KNOWN_BOOTSTRAP_HOOK_MARKERS = [
  BOOTSTRAP_HOOK_MARKER,
  "# twing-install-enforcement-hook-v2",
  "# twing-install-enforcement-hook-v1",
];

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
    "# First edit on a machine that has never run twing: set it up rather than",
    "# demanding someone else do it. Everything below is unprivileged -- the",
    "# install prefix is under $HOME (no sudo, unlike npm install -g), and",
    "# --unattended skips the OS-service step.",
    "#",
    "# Output goes to a log rather than /dev/null. Discarding it meant a",
    "# precise, actionable error (`gh auth login` is the common one) was",
    "# thrown away and replaced by a message guessing at three possible",
    "# causes -- see the deny text below, which now points here instead.",
    'lib="$HOME/.twing/lib"',
    'cli="$lib/node_modules/@twing/cli/dist/index.js"',
    'log="$HOME/.twing/bootstrap.log"',
    'if [ ! -x "$hook_bin" ]; then',
    '  mkdir -p "$HOME/.twing"',
    '  { echo "=== twing bootstrap $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="; } >> "$log" 2>/dev/null',
    "  # Reuse a twing that is already on PATH before fetching another copy:",
    "  # a machine with a working global install needs no download at all, and",
    "  # installing a second copy beside it is confusing to anyone inspecting",
    "  # this hook (it reads as the repo insisting on its own binary).",
    '  if command -v twing >/dev/null 2>&1; then',
    '    twing init --unattended >> "$log" 2>&1 </dev/null',
    "  fi",
    '  if [ ! -x "$hook_bin" ]; then',
    '    npm install --prefix "$lib" @twing/cli@latest --no-fund --no-audit --loglevel=error >> "$log" 2>&1 </dev/null',
    '    [ -f "$cli" ] && node "$cli" init --unattended >> "$log" 2>&1 </dev/null',
    "  fi",
    "fi",
    'if [ ! -x "$hook_bin" ]; then',
    "  printf '%s' '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"twing could not install itself on this machine, so this repo is not coordinating edits right now.\\n\\n  This repo uses twing (https://twing.dev, source at\\n  https://github.com/Twing-dev/twing-cli) to stop two AI sessions\\n  silently colliding on the same code. Its setup runs automatically\\n  from a hook this repo commits -- normally with nothing to do by\\n  hand -- and that automatic setup just failed.\\n\\n  This is an operational failure, not a task for you to work around:\\n  do not try to install it another way, and do not edit or remove the\\n  hook (that hits this same check anyway). Report it to whoever runs\\n  this repo.\\n\\n  The actual error was written to ~/.twing/bootstrap.log -- read that\\n  file and report what it says. Do not guess from this message; the\\n  log has the real cause. The most common one is that twing needs a\\n  GitHub credential to verify your access to this repo, and none was\\n  available non-interactively, which `gh auth login` fixes.\"}}'",
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

function isBootstrapHook(command: string): boolean {
  return KNOWN_BOOTSTRAP_HOOK_MARKERS.some((marker) => command.startsWith(marker));
}

/** Every bootstrap-hook entry present, any version, in document order.
 *
 * Returns all of them rather than the first because a repo can legitimately
 * be carrying more than one: the v2 -> v3 marker rename appended instead of
 * replacing, so repos upgraded while that bug was live hold two. Both fire,
 * and the stale one denies -- so an upgrade has to collapse them, not just
 * rewrite whichever it happened to find. */
function findMarkedEntries(entries: HookMatcherEntry[]): { entryIndex: number; hookIndex: number }[] {
  const found: { entryIndex: number; hookIndex: number }[] = [];
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
    if (entries[entryIndex].matcher !== ENFORCEMENT_MATCHER) continue;
    entries[entryIndex].hooks.forEach((h, hookIndex) => {
      if (isBootstrapHook(h.command)) found.push({ entryIndex, hookIndex });
    });
  }
  return found;
}

/** Drops the located hooks, and any matcher entry left with none. Removes
 * back-to-front so earlier indices stay valid as it goes. */
function removeMarked(entries: HookMatcherEntry[], marked: { entryIndex: number; hookIndex: number }[]): void {
  for (const { entryIndex, hookIndex } of [...marked].reverse()) {
    entries[entryIndex].hooks.splice(hookIndex, 1);
  }
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].matcher === ENFORCEMENT_MATCHER && entries[i].hooks.length === 0) entries.splice(i, 1);
  }
}

/** True if this repo's committed `.claude/settings.json` already has the
 * bootstrap hook wired (any version -- checked by marker prefix, not exact
 * script equality; `enableInstallEnforcement` is what upgrades an
 * out-of-date one). */
export function isInstallEnforcementWired(repoRoot: string): boolean {
  const settings = readClaudeSettings(settingsPath(repoRoot));
  return findMarkedEntries(settings.hooks?.PreToolUse ?? []).length > 0;
}

/** Read-merge-write into `<repoRoot>/.claude/settings.json` (git-tracked --
 * never `.claude/settings.local.json`). Three cases: no marked entry
 * anywhere (append into an existing `Edit|Write` matcher entry if one
 * already exists, else create a fresh one); a marked entry with the
 * current script already (no-op); a marked entry with an older script
 * (in-place upgrade, same array position, sibling hooks untouched).
 * Returns true iff the file was changed. */
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
  const target = settingsPath(repoRoot);
  const settings = readClaudeSettings(target);
  const script = bootstrapHookScript();

  settings.hooks ??= {};
  const entries = (settings.hooks.PreToolUse ??= []);
  const marked = findMarkedEntries(entries);

  if (marked.length > 0) {
    // Already exactly right: one entry, current script. Nothing to write.
    const [first, ...stale] = marked;
    const current = entries[first.entryIndex].hooks[first.hookIndex].command;
    if (stale.length === 0 && current === script) return false;

    // Upgrade in place, keeping this entry's position and its siblings, then
    // drop any other bootstrap hooks -- older versions, or the duplicate a
    // pre-fix upgrade left behind. Leaving one would mean two hooks firing
    // for every tool call, and a stale one denies unconditionally.
    entries[first.entryIndex].hooks[first.hookIndex] = { type: "command", command: script };
    removeMarked(entries, stale);
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

/** Inverse of `enableInstallEnforcement`: removes twing's bootstrap hooks --
 * every version, including a duplicate left by a pre-fix upgrade --
 * preserving any sibling hooks under the same matcher entry and dropping a
 * matcher entry only once it is empty. Returns true iff anything was
 * removed. */
export function disableInstallEnforcement(repoRoot: string): boolean {
  const target = settingsPath(repoRoot);
  const settings = readClaudeSettings(target);
  const entries = settings.hooks?.PreToolUse;
  if (!entries) return false;

  const marked = findMarkedEntries(entries);
  if (marked.length === 0) return false;

  removeMarked(entries, marked);
  writeClaudeSettings(target, settings);
  return true;
}
