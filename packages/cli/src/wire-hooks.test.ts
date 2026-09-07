/**
 * `wireHooks` (wire-hooks.ts) -- pure filesystem operations against the
 * user-level `~/.claude/settings.json` (retargeted from repo-local as part
 * of the install-once onboarding work -- see wireHooks's own doc comment
 * for why), no network or subprocess involved. Isolates `$HOME` per test
 * rather than passing a `repoRoot` -- there's no repo-scoped path left to
 * pass.
 *
 * `wireDesignGate` (the PreToolUse/SessionEnd half) is no longer exported
 * standalone -- `design enable-gate`/`disable-gate` use the per-project
 * override (`gate-overrides.ts`) instead now that wiring is global; see
 * design.test.ts for that coverage. `wireHooks` itself still wires both
 * halves in one call, covered below.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { wireHooks, stripLegacyRepoLocalHooks, unwireHooks } from "./wire-hooks.js";
import { bootstrapHookScript } from "./enforce-hooks.js";

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

function withIsolatedHome<T>(fn: () => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "twing-wire-hooks-test-"));
  const original = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env.HOME;
    else process.env.HOME = original;
  }
}

function settingsPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}

function readSettings(): ClaudeSettings {
  return JSON.parse(fs.readFileSync(settingsPath(), "utf8")) as ClaudeSettings;
}

const HOOK_PATH = "/usr/local/bin/twing-hook";

// --- wireHooks ----------------------------------------------------------------

test("wireHooks: wires the capture-path entries plus the design-gate entries into ~/.claude/settings.json, and returns true", () => {
  withIsolatedHome(() => {
    const changed = wireHooks(HOOK_PATH);
    assert.equal(changed, true);

    const settings = readSettings();
    assert.deepEqual(settings.hooks?.PostToolUse, [{ matcher: "Edit|Write|Read|Grep|Glob", hooks: [{ type: "command", command: HOOK_PATH }] }]);
    assert.deepEqual(settings.hooks?.SessionStart, [{ hooks: [{ type: "command", command: HOOK_PATH }] }]);
    assert.deepEqual(settings.hooks?.UserPromptSubmit, [{ hooks: [{ type: "command", command: HOOK_PATH }] }]);
    assert.deepEqual(settings.hooks?.PreToolUse, [
      { matcher: "ExitPlanMode", hooks: [{ type: "command", command: HOOK_PATH }] },
      { matcher: "Edit|Write", hooks: [{ type: "command", command: HOOK_PATH }] },
    ]);
    assert.deepEqual(settings.hooks?.SessionEnd, [{ hooks: [{ type: "command", command: HOOK_PATH }] }]);
  });
});

test("wireHooks: calling it again is a no-op and returns false", () => {
  withIsolatedHome(() => {
    wireHooks(HOOK_PATH);
    const before = readSettings();
    const changed = wireHooks(HOOK_PATH);
    assert.equal(changed, false);
    assert.deepEqual(readSettings(), before);
  });
});

test("wireHooks: merges into an existing settings.json without touching unrelated keys or another tool's hooks", () => {
  withIsolatedHome(() => {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(
      settingsPath(),
      JSON.stringify({ someOtherTopLevelSetting: true, hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "some-other-tool" }] }] } }),
    );

    wireHooks(HOOK_PATH);
    const settings = readSettings();
    assert.equal(settings.someOtherTopLevelSetting, true);
    assert.equal(settings.hooks?.PostToolUse?.length, 2, "the other tool's entry must survive alongside twing's own");
    assert.ok(settings.hooks?.PostToolUse?.some((e) => e.hooks.some((h) => h.command === "some-other-tool")));
    assert.ok(settings.hooks?.PostToolUse?.some((e) => e.hooks.some((h) => h.command === HOOK_PATH)));
  });
});

// --- stripLegacyRepoLocalHooks vs. the install-enforcement hook (regression) ---
//
// Both mechanisms write to the same file (<repoRoot>/.claude/settings.json),
// which is the one place they share a target. stripLegacyRepoLocalHooks
// matches by exact `command === hookPath` (a resolved absolute binary path);
// the enforcement hook's command is a multi-line script that can never equal
// that string -- confirmed by construction, pinned here so a future change
// to either matching strategy can't silently regress it.

test("stripLegacyRepoLocalHooks: never removes an install-enforcement hook entry sharing the same repo-local settings file", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "twing-wire-hooks-strip-test-"));
  const repoSettingsPath = path.join(repoRoot, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(repoSettingsPath), { recursive: true });
  fs.writeFileSync(
    repoSettingsPath,
    JSON.stringify({
      hooks: {
        PostToolUse: [{ matcher: "Edit|Write|Read|Grep|Glob", hooks: [{ type: "command", command: HOOK_PATH }] }],
        PreToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: bootstrapHookScript() }] }],
      },
    }),
  );

  const changed = stripLegacyRepoLocalHooks(repoRoot, HOOK_PATH);
  assert.equal(changed, true, "the legacy PostToolUse entry (by resolved path) must still be stripped");

  const settings: ClaudeSettings = JSON.parse(fs.readFileSync(repoSettingsPath, "utf8"));
  assert.deepEqual(settings.hooks?.PostToolUse, [], "the legacy entry's matcher block is now empty");
  assert.deepEqual(settings.hooks?.PreToolUse, [{ matcher: "Edit|Write", hooks: [{ type: "command", command: bootstrapHookScript() }] }], "the enforcement hook must be untouched, byte-for-byte");
});

// --- unwireHooks (twing uninstall) -------------------------------------------

test("unwireHooks: removes every twing entry from ~/.claude/settings.json and returns true", () => {
  withIsolatedHome(() => {
    wireHooks(HOOK_PATH);
    const changed = unwireHooks(HOOK_PATH);
    assert.equal(changed, true);

    const settings = readSettings();
    const remaining = Object.values(settings.hooks ?? {}).flat();
    assert.deepEqual(remaining, [], "leaving entries behind would point Claude Code at a deleted binary");
  });
});

test("unwireHooks: leaves another tool's hooks and unrelated settings untouched", () => {
  withIsolatedHome(() => {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(
      settingsPath(),
      JSON.stringify({ someOtherTopLevelSetting: true, hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "some-other-tool" }] }] } }),
    );
    wireHooks(HOOK_PATH);
    unwireHooks(HOOK_PATH);

    const settings = readSettings();
    assert.equal(settings.someOtherTopLevelSetting, true);
    const remaining = Object.values(settings.hooks ?? {}).flat().flatMap((e) => e.hooks.map((h) => h.command));
    assert.deepEqual(remaining, ["some-other-tool"]);
  });
});

test("unwireHooks: no-op (returns false) when nothing is wired", () => {
  withIsolatedHome(() => {
    assert.equal(unwireHooks(HOOK_PATH), false);
  });
});
