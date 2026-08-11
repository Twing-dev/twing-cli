/**
 * Merges twing's hook entries into `<repoRoot>/.claude/settings.json`
 * (§6 step 3). Must never overwrite the file — another tool may already
 * have entries there — so this only ever reads, appends if missing, writes.
 */

import * as fs from "node:fs";
import * as path from "node:path";

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

/** Removes just this hook's command from a matcher entry, dropping the
 * entry entirely once empty -- mirror image of `addEntry`, for
 * `unwireDesignGate`. Never touches entries other tools may have added. */
function removeEntry(settings: ClaudeSettings, eventName: string, hookPath: string, matcher?: string): boolean {
  const entries = settings.hooks?.[eventName];
  if (!entries) return false;
  const before = entries.length;
  settings.hooks![eventName] = entries.filter((entry) => {
    if (entry.matcher !== matcher) return true;
    entry.hooks = entry.hooks.filter((h) => h.command !== hookPath);
    return entry.hooks.length > 0;
  });
  return settings.hooks![eventName].length !== before;
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
export function wireHooks(repoRoot: string, hookPath: string): boolean {
  const settingsPath = path.join(repoRoot, ".claude", "settings.json");
  const settings = readSettings(settingsPath);

  const changedPostToolUse = addEntry(settings, "PostToolUse", hookPath, POST_TOOL_USE_MATCHER);
  const changedSessionStart = addEntry(settings, "SessionStart", hookPath);
  const changedUserPromptSubmit = addEntry(settings, "UserPromptSubmit", hookPath);
  const changed = changedPostToolUse || changedSessionStart || changedUserPromptSubmit;

  if (changed) {
    writeSettings(settingsPath, settings);
  }

  // §17: wired by default now, alongside the capture-path entries above --
  // a separate read/write round trip against the same file, kept as its
  // own function (`wireDesignGate`) so `twing design enable-gate` can call
  // it standalone for repos that ran `init` before this existed.
  const changedDesignGate = wireDesignGate(repoRoot, hookPath);

  return changed || changedDesignGate;
}

/** §17: wires the PreToolUse design-gate matchers plus a SessionEnd close
 * trigger (§17.6). Returns true if the file was changed. */
export function wireDesignGate(repoRoot: string, hookPath: string): boolean {
  const settingsPath = path.join(repoRoot, ".claude", "settings.json");
  const settings = readSettings(settingsPath);

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

/** Unwinds `wireDesignGate` -- for `twing design disable-gate`. Leaves the
 * capture-path entries (PostToolUse/SessionStart/UserPromptSubmit)
 * untouched; those stay advisory regardless of the gate's state. */
export function unwireDesignGate(repoRoot: string, hookPath: string): boolean {
  const settingsPath = path.join(repoRoot, ".claude", "settings.json");
  if (!fs.existsSync(settingsPath)) return false;
  const settings = readSettings(settingsPath);

  let changed = false;
  for (const matcher of DESIGN_GATE_PRE_TOOL_USE_MATCHERS) {
    changed = removeEntry(settings, "PreToolUse", hookPath, matcher) || changed;
  }
  changed = removeEntry(settings, "SessionEnd", hookPath) || changed;

  if (changed) {
    writeSettings(settingsPath, settings);
  }
  return changed;
}
