/**
 * Shared low-level read/write for a Claude Code `settings.json` file --
 * extracted from `wire-hooks.ts` (which writes the user-level
 * `~/.claude/settings.json`) so a second mechanism that writes a
 * *repo-local* `.claude/settings.json` (`enforce-hooks.ts`, packages/cli)
 * can't silently diverge from it in file-format details (indentation,
 * trailing newline, etc). Pure filesystem primitives, no merge/dedup logic
 * of its own -- that stays with each caller, since the two mechanisms merge
 * differently (see `enforce-hooks.ts`'s own doc comment for why).
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface HookCommand {
  type: "command";
  command: string;
}

export interface HookMatcherEntry {
  matcher?: string;
  hooks: HookCommand[];
}

export interface ClaudeSettings {
  hooks?: Record<string, HookMatcherEntry[]>;
  [key: string]: unknown;
}

export function readClaudeSettings(settingsPath: string): ClaudeSettings {
  if (!fs.existsSync(settingsPath)) return {};
  return JSON.parse(fs.readFileSync(settingsPath, "utf8")) as ClaudeSettings;
}

export function writeClaudeSettings(settingsPath: string, settings: ClaudeSettings): void {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}
