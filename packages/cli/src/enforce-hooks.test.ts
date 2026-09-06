/**
 * `enforce-hooks.ts` -- pure filesystem merge/dedup logic against a repo's
 * committed `.claude/settings.json`, plus real-`sh`-execution tests of the
 * generated script itself (not just JS-string equality) to catch actual
 * shell-syntax bugs. See that file's own doc comment for the mechanism.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bootstrapHookScript, isInstallEnforcementWired, enableInstallEnforcement, disableInstallEnforcement, BOOTSTRAP_HOOK_MARKER } from "./enforce-hooks.js";

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

function tmpRepoRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "twing-enforce-hooks-test-"));
}

function settingsPath(repoRoot: string): string {
  return path.join(repoRoot, ".claude", "settings.json");
}

function readSettings(repoRoot: string): ClaudeSettings {
  return JSON.parse(fs.readFileSync(settingsPath(repoRoot), "utf8")) as ClaudeSettings;
}

// --- enableInstallEnforcement / disableInstallEnforcement / isInstallEnforcementWired ---

test("enableInstallEnforcement: creates .claude/settings.json with the bootstrap hook, returns true", () => {
  const repoRoot = tmpRepoRoot();
  const changed = enableInstallEnforcement(repoRoot);
  assert.equal(changed, true);
  assert.equal(isInstallEnforcementWired(repoRoot), true);
  const settings = readSettings(repoRoot);
  assert.deepEqual(settings.hooks?.PreToolUse?.length, 1);
  assert.equal(settings.hooks?.PreToolUse?.[0].matcher, "Edit|Write");
  assert.equal(settings.hooks?.PreToolUse?.[0].hooks[0].command, bootstrapHookScript());
});

test("enableInstallEnforcement: calling it again is a no-op and returns false", () => {
  const repoRoot = tmpRepoRoot();
  enableInstallEnforcement(repoRoot);
  const before = readSettings(repoRoot);
  const changed = enableInstallEnforcement(repoRoot);
  assert.equal(changed, false);
  assert.deepEqual(readSettings(repoRoot), before);
});

test("enableInstallEnforcement: appends into an existing Edit|Write matcher entry instead of creating a duplicate matcher block", () => {
  const repoRoot = tmpRepoRoot();
  fs.mkdirSync(path.dirname(settingsPath(repoRoot)), { recursive: true });
  fs.writeFileSync(
    settingsPath(repoRoot),
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "some-other-tool" }] }] } }),
  );
  enableInstallEnforcement(repoRoot);
  const settings = readSettings(repoRoot);
  assert.equal(settings.hooks?.PreToolUse?.length, 1, "must not create a second Edit|Write matcher block");
  assert.equal(settings.hooks?.PreToolUse?.[0].hooks.length, 2);
  assert.ok(settings.hooks?.PreToolUse?.[0].hooks.some((h) => h.command === "some-other-tool"));
  assert.ok(settings.hooks?.PreToolUse?.[0].hooks.some((h) => h.command.startsWith(BOOTSTRAP_HOOK_MARKER)));
});

test("enableInstallEnforcement: upgrades an older marked entry in place, same array position, siblings untouched", () => {
  const repoRoot = tmpRepoRoot();
  fs.mkdirSync(path.dirname(settingsPath(repoRoot)), { recursive: true });
  fs.writeFileSync(
    settingsPath(repoRoot),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: "Edit|Write", hooks: [{ type: "command", command: "some-other-tool" }, { type: "command", command: `${BOOTSTRAP_HOOK_MARKER}\nold-body` }] },
        ],
      },
    }),
  );
  const changed = enableInstallEnforcement(repoRoot);
  assert.equal(changed, true);
  const settings = readSettings(repoRoot);
  assert.equal(settings.hooks?.PreToolUse?.length, 1, "must not create a second matcher entry");
  assert.equal(settings.hooks?.PreToolUse?.[0].hooks.length, 2, "must replace in place, not append a third hook");
  assert.equal(settings.hooks?.PreToolUse?.[0].hooks[0].command, "some-other-tool", "the sibling hook must survive untouched, same position");
  assert.equal(settings.hooks?.PreToolUse?.[0].hooks[1].command, bootstrapHookScript());
});

test("disableInstallEnforcement: removes only the marked hook, leaves siblings and returns true", () => {
  const repoRoot = tmpRepoRoot();
  fs.mkdirSync(path.dirname(settingsPath(repoRoot)), { recursive: true });
  fs.writeFileSync(
    settingsPath(repoRoot),
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "some-other-tool" }] }] } }),
  );
  enableInstallEnforcement(repoRoot);
  const removed = disableInstallEnforcement(repoRoot);
  assert.equal(removed, true);
  const settings = readSettings(repoRoot);
  assert.equal(settings.hooks?.PreToolUse?.length, 1, "the matcher entry survives -- the other tool's hook is still there");
  assert.equal(settings.hooks?.PreToolUse?.[0].hooks.length, 1);
  assert.equal(settings.hooks?.PreToolUse?.[0].hooks[0].command, "some-other-tool");
});

test("disableInstallEnforcement: drops the matcher entry entirely once empty", () => {
  const repoRoot = tmpRepoRoot();
  enableInstallEnforcement(repoRoot);
  disableInstallEnforcement(repoRoot);
  const settings = readSettings(repoRoot);
  assert.equal(settings.hooks?.PreToolUse?.length ?? 0, 0);
});

test("disableInstallEnforcement: no-op (returns false) when nothing is wired", () => {
  const repoRoot = tmpRepoRoot();
  assert.equal(disableInstallEnforcement(repoRoot), false);
});

test("isInstallEnforcementWired: false before enabling, true after", () => {
  const repoRoot = tmpRepoRoot();
  assert.equal(isInstallEnforcementWired(repoRoot), false);
  enableInstallEnforcement(repoRoot);
  assert.equal(isInstallEnforcementWired(repoRoot), true);
});

// --- the generated script itself, run through a real `sh -c` ------------------

function runScript(cwd: string, home: string): { stdout: string; status: number } {
  try {
    const stdout = execFileSync("sh", ["-c", bootstrapHookScript()], { cwd, env: { HOME: home, PATH: process.env.PATH ?? "" } });
    return { stdout: stdout.toString(), status: 0 };
  } catch (err) {
    const e = err as { stdout?: Buffer; status?: number };
    return { stdout: e.stdout?.toString() ?? "", status: e.status ?? 1 };
  }
}

function fakeHome(hookInstalled: boolean, hookWired: boolean): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "twing-enforce-hooks-home-"));
  if (hookInstalled) {
    const binDir = path.join(home, ".twing", "bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, "twing-hook"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  if (hookWired) {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: path.join(home, ".twing", "bin", "twing-hook") }] }] } }));
  }
  return home;
}

test("bootstrapHookScript: allows when the hook is installed and wired", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "twing-enforce-hooks-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  fs.mkdirSync(path.join(repo, ".twing"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".twing", "twing.yml"), "coordinator:\n  serverUrl: http://localhost:9999\n");
  const home = fakeHome(true, true);
  const { stdout, status } = runScript(repo, home);
  assert.equal(status, 0);
  assert.deepEqual(JSON.parse(stdout), { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } });
});

test("bootstrapHookScript: denies with instructions when nothing is installed", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "twing-enforce-hooks-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  fs.mkdirSync(path.join(repo, ".twing"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".twing", "twing.yml"), "coordinator:\n  serverUrl: http://localhost:9999\n");
  const home = fakeHome(false, false);
  const { stdout, status } = runScript(repo, home);
  assert.equal(status, 0, "the hook itself must always exit 0 regardless of allow/deny");
  const parsed = JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /npm install -g @twing\/cli && twing init/);
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /there is no personal bypass/i);
});

test("bootstrapHookScript: denies when the binary exists but isn't wired", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "twing-enforce-hooks-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  fs.mkdirSync(path.join(repo, ".twing"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".twing", "twing.yml"), "coordinator:\n  serverUrl: http://localhost:9999\n");
  const home = fakeHome(true, false);
  const { stdout } = runScript(repo, home);
  const parsed = JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string } };
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
});

test("bootstrapHookScript: silent no-op (empty stdout, exit 0) outside a git repo", () => {
  const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "twing-enforce-hooks-notrepo-"));
  const home = fakeHome(true, true);
  const { stdout, status } = runScript(notARepo, home);
  assert.equal(status, 0);
  assert.equal(stdout, "");
});

test("bootstrapHookScript: silent no-op when the repo has no .twing/twing.yml", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "twing-enforce-hooks-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const home = fakeHome(true, true);
  const { stdout, status } = runScript(repo, home);
  assert.equal(status, 0);
  assert.equal(stdout, "");
});
