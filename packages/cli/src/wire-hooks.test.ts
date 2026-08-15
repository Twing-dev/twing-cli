/**
 * `wireHooks`/`wireDesignGate`/`unwireDesignGate` (wire-hooks.ts) -- pure
 * filesystem operations against `<repoRoot>/.claude/settings.json`, no
 * network or subprocess involved, so these run directly against a plain
 * tmpdir (no git repo needed -- these functions take `repoRoot` as a
 * literal path, they don't call `findRepoRoot` themselves).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { wireHooks, wireDesignGate, unwireDesignGate } from "./wire-hooks.js";

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

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "twing-wire-hooks-test-"));
}

function readSettings(repoRoot: string): ClaudeSettings {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, ".claude", "settings.json"), "utf8")) as ClaudeSettings;
}

const HOOK_PATH = "/usr/local/bin/twing-hook";

// --- wireHooks ----------------------------------------------------------------

test("wireHooks: wires the capture-path entries plus the design-gate entries in one call, and returns true", () => {
  const repo = tmpDir();
  const changed = wireHooks(repo, HOOK_PATH);
  assert.equal(changed, true);

  const settings = readSettings(repo);
  assert.deepEqual(settings.hooks?.PostToolUse, [{ matcher: "Edit|Write|Read|Grep|Glob", hooks: [{ type: "command", command: HOOK_PATH }] }]);
  assert.deepEqual(settings.hooks?.SessionStart, [{ hooks: [{ type: "command", command: HOOK_PATH }] }]);
  assert.deepEqual(settings.hooks?.UserPromptSubmit, [{ hooks: [{ type: "command", command: HOOK_PATH }] }]);
  assert.deepEqual(settings.hooks?.PreToolUse, [
    { matcher: "ExitPlanMode", hooks: [{ type: "command", command: HOOK_PATH }] },
    { matcher: "Edit|Write", hooks: [{ type: "command", command: HOOK_PATH }] },
  ]);
  assert.deepEqual(settings.hooks?.SessionEnd, [{ hooks: [{ type: "command", command: HOOK_PATH }] }]);
});

test("wireHooks: calling it again is a no-op and returns false", () => {
  const repo = tmpDir();
  wireHooks(repo, HOOK_PATH);
  const before = readSettings(repo);
  const changed = wireHooks(repo, HOOK_PATH);
  assert.equal(changed, false);
  assert.deepEqual(readSettings(repo), before);
});

test("wireHooks: merges into an existing settings.json without touching unrelated keys or another tool's hooks", () => {
  const repo = tmpDir();
  fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, ".claude", "settings.json"),
    JSON.stringify({ someOtherTopLevelSetting: true, hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "some-other-tool" }] }] } }),
  );

  wireHooks(repo, HOOK_PATH);
  const settings = readSettings(repo);
  assert.equal(settings.someOtherTopLevelSetting, true);
  assert.equal(settings.hooks?.PostToolUse?.length, 2, "the other tool's entry must survive alongside twing's own");
  assert.ok(settings.hooks?.PostToolUse?.some((e) => e.hooks.some((h) => h.command === "some-other-tool")));
  assert.ok(settings.hooks?.PostToolUse?.some((e) => e.hooks.some((h) => h.command === HOOK_PATH)));
});

// --- wireDesignGate / unwireDesignGate ----------------------------------------

test("wireDesignGate: standalone, wires only PreToolUse+SessionEnd, not the capture-path entries", () => {
  const repo = tmpDir();
  const changed = wireDesignGate(repo, HOOK_PATH);
  assert.equal(changed, true);
  const settings = readSettings(repo);
  assert.equal(settings.hooks?.PostToolUse, undefined);
  assert.equal(settings.hooks?.PreToolUse?.length, 2);
  assert.equal(settings.hooks?.SessionEnd?.length, 1);
});

test("wireDesignGate: idempotent", () => {
  const repo = tmpDir();
  wireDesignGate(repo, HOOK_PATH);
  assert.equal(wireDesignGate(repo, HOOK_PATH), false);
});

test("unwireDesignGate: removes exactly the design-gate entries, leaving capture-path entries untouched", () => {
  const repo = tmpDir();
  wireHooks(repo, HOOK_PATH); // both capture-path and design-gate

  const changed = unwireDesignGate(repo, HOOK_PATH);
  assert.equal(changed, true);

  const settings = readSettings(repo);
  assert.deepEqual(settings.hooks?.PreToolUse, [], "PreToolUse entries are emptied (removeEntry filters to [], doesn't delete the key)");
  assert.deepEqual(settings.hooks?.SessionEnd, []);
  // Capture-path entries (advisory, unaffected by the gate's on/off state) survive.
  assert.equal(settings.hooks?.PostToolUse?.length, 1);
  assert.equal(settings.hooks?.SessionStart?.length, 1);
  assert.equal(settings.hooks?.UserPromptSubmit?.length, 1);
});

test("unwireDesignGate: a no-op (returns false) when nothing was wired, or the settings file doesn't exist at all", () => {
  const repo = tmpDir();
  assert.equal(unwireDesignGate(repo, HOOK_PATH), false);

  wireHooks(repo, HOOK_PATH);
  unwireDesignGate(repo, HOOK_PATH);
  assert.equal(unwireDesignGate(repo, HOOK_PATH), false, "already unwired -- calling again must still be a no-op");
});
