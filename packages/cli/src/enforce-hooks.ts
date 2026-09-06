/**
 * Admin-driven install enforcement: merges a single `PreToolUse`/`Edit|Write`
 * hook into a repo's own, **git-tracked** `.claude/settings.json` (never
 * `.claude/settings.local.json`) -- the one committed artifact that forces
 * every future clone of the repo to refuse `Edit`/`Write` until that
 * developer has personally run `twing init`. Distinct in kind from
 * `wire-hooks.ts`'s `wireHooks`, which only ever writes the machine-global
 * `~/.claude/settings.json`: that file is per-machine and purely opt-in,
 * so a teammate who never ran `init` has zero hooks configured at all for a
 * twing-enabled repo. This is the repo-committed counterpart that closes
 * that gap. Confirmed against Claude Code's own docs: hooks from different
 * settings scopes merge and all fire in parallel for the same event/matcher
 * -- this hook and the (eventually machine-wired) real design-gate hook
 * coexist safely, never double up on each other's work. This hook's only
 * job is "is twing installed at all" -- once it allows, the real Go hook
 * (once wired) handles the actual §17 gate/capture work.
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

export const BOOTSTRAP_HOOK_MARKER = "# twing-install-enforcement-hook-v1";

const ENFORCEMENT_MATCHER = "Edit|Write";

/**
 * The exact script installed as this hook entry's `command`. Portable
 * across every developer's machine unmodified -- `$HOME` is a literal shell
 * variable in the committed text, expanded locally at hook-execution time
 * on each developer's own machine, unlike `wireHooks`' baked-in resolved
 * path (which only works on the machine it was wired on). No `jq`/`node`/
 * `npx` on this steady-state path -- only `git`, `test`, `grep`, `printf`,
 * universally present on any POSIX `sh`. A failed `git rev-parse` or a
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
    'if [ -x "$hook_bin" ] && [ -f "$settings" ] && grep -qF "$hook_bin" "$settings" 2>/dev/null; then',
    "  printf '%s' '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"allow\"}}'",
    "  exit 0",
    "fi",
    "printf '%s' '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"twing is not installed on this machine yet.\\n  This repo requires every contributor to run twing init once before\\n  editing -- it coordinates concurrent AI-assisted changes across the\\n  team so two sessions do not silently collide on the same code.\\n\\n  What now\\n    Install and run twing init\\n      npm install -g @twing/cli && twing init\\n    Or, without a global install\\n      npx @twing/cli@latest init\\n\\n  Note: this check is admin-enabled for this repo (committed in\\n  .claude/settings.json) -- there is no personal bypass for it. Only\\n  editing that committed file (reviewed like any other change), or\\n  twing project disable-enforcement, lifts it.\"}}'",
    "exit 0",
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
