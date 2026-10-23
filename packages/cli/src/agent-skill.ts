/**
 * Machine-global install of twing's agent skill (`skill/SKILL.md`).
 *
 * The skill tells an agent how to use twing before it starts, rather than
 * leaving it to learn from the first deny. Two copies:
 *
 *  - `~/.claude/skills/twing/SKILL.md` for Claude Code. OpenCode reads
 *    `~/.claude/skills/` too, so it needs no copy of its own.
 *  - `<CODEX_HOME>/skills/twing/SKILL.md` for Codex, written whether or not
 *    Codex is installed yet, for the reason `codex-hooks.ts` gives: a Codex
 *    installed later must find it without anyone running a command.
 *
 * Written on every `twing init`, unattended included, so the first update
 * after a coordinator upgrade installs it on every existing machine and each
 * later one keeps it matching the installed CLI.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { codexHome } from "./codex-hooks.js";

/** Matches every skill version twing has written, so upgrades and uninstall
 * recognise older ones. Not a first-line check: the marker sits after the
 * frontmatter, which agents require at the top of the file. */
const SKILL_MARKER_PREFIX = "<!-- twing-skill-v";

export function claudeSkillPath(): string {
  return path.join(os.homedir(), ".claude", "skills", "twing", "SKILL.md");
}

export function codexSkillPath(): string {
  return path.join(codexHome(), "skills", "twing", "SKILL.md");
}

/** `skill/` sits beside `dist/` in the package (`files` in package.json). */
export function bundledSkillPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "skill", "SKILL.md");
}

function writeAtomically(target: string, contents: Buffer): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, contents);
    try {
      fs.renameSync(temporary, target);
    } catch {
      // Windows cannot rename over an existing file.
      fs.rmSync(target, { force: true });
      fs.renameSync(temporary, target);
    }
  } catch (err) {
    fs.rmSync(temporary, { force: true });
    throw err;
  }
}

function isTwingSkill(target: string): boolean {
  try {
    return fs.readFileSync(target, "utf8").includes(SKILL_MARKER_PREFIX);
  } catch {
    return false;
  }
}

/**
 * Writes or upgrades both copies. Returns true on change.
 *
 * Leaves a same-named skill that isn't twing's alone, with a warning, the
 * same as `wireOpenCodePlugin`.
 */
export function wireAgentSkill(): boolean {
  const skill = fs.readFileSync(bundledSkillPath());
  let changed = false;
  for (const target of [claudeSkillPath(), codexSkillPath()]) {
    if (fs.existsSync(target) && !isTwingSkill(target)) {
      console.warn(`twing: left ${target} alone -- it isn't twing's. Move it and re-run setup to give agents twing's skill.`);
      continue;
    }
    let current: Buffer | undefined;
    try {
      current = fs.readFileSync(target);
    } catch {
      current = undefined;
    }
    if (current?.equals(skill)) continue;
    writeAtomically(target, skill);
    changed = true;
  }
  return changed;
}

/**
 * `wireAgentSkill` for `twing init`, which also runs inside every unattended
 * upgrade. A failure there would leave the hook binary stale and deny every
 * edit for the recovery cooldown -- far worse than a missing skill -- so any
 * error becomes one warning.
 */
export function refreshAgentSkill(): boolean {
  try {
    return wireAgentSkill();
  } catch (err) {
    console.warn(`twing: couldn't install twing's agent skill (${err instanceof Error ? err.message : String(err)}); carrying on without it.`);
    return false;
  }
}

/** Removes twing's copies, preserving any same-named user skill. */
export function unwireAgentSkill(): boolean {
  let changed = false;
  for (const target of [claudeSkillPath(), codexSkillPath()]) {
    if (!isTwingSkill(target)) continue;
    fs.rmSync(target);
    changed = true;
    try {
      fs.rmdirSync(path.dirname(target));
    } catch {
      // Not empty: something else lives beside it. Leave the folder.
    }
  }
  return changed;
}
