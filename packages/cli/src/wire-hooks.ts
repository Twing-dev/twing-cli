/**
 * Merges twing's hook entries into the user-level `~/.claude/settings.json`
 * (§6 step 3, retargeted from repo-local as part of the install-once
 * onboarding work). Every downstream check already tolerates "no
 * coordinator configured for this repo" as a silent no-op (capture) or
 * silent allow (gate) -- so wiring once, globally, means every repo a
 * developer works in already has hooks active, no per-repo `wireHooks` run
 * needed. Must never overwrite the file — another tool may already have
 * entries there — so this only ever reads, appends if missing, writes.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function globalSettingsPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}

interface HookCommand {
  type: "command";
  command: string;
}

interface HookMatcherEntry {
  matcher?: string;
  hooks: HookCommand[];
}

interface ClaudeSettings {
  hooks?: Record<string, HookMatcherEntry[]>;
  [key: string]: unknown;
}

const POST_TOOL_USE_MATCHER = "Edit|Write|Read|Grep|Glob";

// §17: the design-gate matchers. `ExitPlanMode` is the fast path;
// `Edit|Write` is the universal fallback for agents that skip plan mode
// (spec §9a) -- same PreToolUse event, two matchers, both denoted here so
// enable/disable-gate stay in sync with what `wireHooks` wires by default.
const DESIGN_GATE_PRE_TOOL_USE_MATCHERS = ["ExitPlanMode", "Edit|Write"];

function alreadyWired(entries: HookMatcherEntry[], hookPath: string, matcher?: string): boolean {
  return entries.some((entry) => entry.matcher === matcher && entry.hooks.some((h) => h.command === hookPath));
}

function addEntry(settings: ClaudeSettings, eventName: string, hookPath: string, matcher?: string): boolean {
  settings.hooks ??= {};
  const existing = (settings.hooks[eventName] ??= []);
  if (alreadyWired(existing, hookPath, matcher)) return false;

  existing.push({
    ...(matcher ? { matcher } : {}),
    hooks: [{ type: "command", command: hookPath }],
  });
  return true;
}

function readSettings(settingsPath: string): ClaudeSettings {
  if (!fs.existsSync(settingsPath)) return {};
  return JSON.parse(fs.readFileSync(settingsPath, "utf8")) as ClaudeSettings;
}

function writeSettings(settingsPath: string, settings: ClaudeSettings): void {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

/** Returns true if the file was changed. */
export function wireHooks(hookPath: string): boolean {
  const settingsPath = globalSettingsPath();
  const settings = readSettings(settingsPath);

  const changedPostToolUse = addEntry(settings, "PostToolUse", hookPath, POST_TOOL_USE_MATCHER);
  const changedSessionStart = addEntry(settings, "SessionStart", hookPath);
  const changedUserPromptSubmit = addEntry(settings, "UserPromptSubmit", hookPath);
  const changed = changedPostToolUse || changedSessionStart || changedUserPromptSubmit;

  if (changed) {
    writeSettings(settingsPath, settings);
  }

  // §17: wired by default now, alongside the capture-path entries above --
  // a separate read/write round trip against the same (now global) file,
  // kept as its own internal helper since `wireHooks` still calls it
  // standalone. No longer exported/called by `design enable-gate`/
  // `disable-gate` -- see gate-overrides.ts for why unwiring a global entry
  // stopped being the right mechanism for a per-repo toggle.
  const changedDesignGate = wireDesignGate(settingsPath, settings, hookPath);

  return changed || changedDesignGate;
}

/** §17: wires the PreToolUse design-gate matchers plus a SessionEnd close
 * trigger (§17.6) into the already-loaded `settings`, writing back if
 * changed. Returns true if the file was changed. */
function wireDesignGate(settingsPath: string, settings: ClaudeSettings, hookPath: string): boolean {
  let changed = false;
  for (const matcher of DESIGN_GATE_PRE_TOOL_USE_MATCHERS) {
    changed = addEntry(settings, "PreToolUse", hookPath, matcher) || changed;
  }
  changed = addEntry(settings, "SessionEnd", hookPath) || changed;

  if (changed) {
    writeSettings(settingsPath, settings);
  }
  return changed;
}

/** Upgrade migration: strips this hook's own entries (by exact command
 * match) from a repo's *local* `.claude/settings.json`, across every event
 * name twing ever wired there -- left behind by `init` runs from before
 * wiring moved to the global file. Run once per `init`; without it, a repo
 * that was `init`'d under the old scheme would end up with both the
 * repo-local and the new global entries wired at once, double-firing the
 * hook for every event in that one repo. Never touches any other tool's
 * entries, and is a silent no-op if the file doesn't exist or has nothing
 * of ours in it -- most repos hit this path exactly zero times. Returns
 * true if anything was actually removed. */
export function stripLegacyRepoLocalHooks(repoRoot: string, hookPath: string): boolean {
  const settingsPath = path.join(repoRoot, ".claude", "settings.json");
  if (!fs.existsSync(settingsPath)) return false;
  const settings = readSettings(settingsPath);
  if (!settings.hooks) return false;

  let changed = false;
  for (const eventName of Object.keys(settings.hooks)) {
    const before = settings.hooks[eventName].length;
    settings.hooks[eventName] = settings.hooks[eventName]
      .map((entry) => ({ ...entry, hooks: entry.hooks.filter((h) => h.command !== hookPath) }))
      .filter((entry) => entry.hooks.length > 0);
    if (settings.hooks[eventName].length !== before) changed = true;
  }

  if (changed) {
    writeSettings(settingsPath, settings);
  }
  return changed;
}
