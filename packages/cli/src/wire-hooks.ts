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

/** Returns true if the file was changed. */
export function wireHooks(repoRoot: string, hookPath: string): boolean {
  const settingsPath = path.join(repoRoot, ".claude", "settings.json");
  let settings: ClaudeSettings = {};
  if (fs.existsSync(settingsPath)) {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as ClaudeSettings;
  }

  const changedPostToolUse = addEntry(settings, "PostToolUse", hookPath, POST_TOOL_USE_MATCHER);
  const changedSessionStart = addEntry(settings, "SessionStart", hookPath);
  const changedUserPromptSubmit = addEntry(settings, "UserPromptSubmit", hookPath);
  const changed = changedPostToolUse || changedSessionStart || changedUserPromptSubmit;

  if (changed) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  }
  return changed;
}
