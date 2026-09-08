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
import { bootstrapHookScript, isInstallEnforcementWired, enableInstallEnforcement, disableInstallEnforcement, BOOTSTRAP_HOOK_MARKER, KNOWN_BOOTSTRAP_HOOK_MARKERS } from "./enforce-hooks.js";

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

/** A PATH that still has the real tools (`git` especially -- the script's
 * first act is `git rev-parse`) but where every route the bootstrap could
 * take is stubbed to fail: an existing `twing`, and `npm`. Stands in for a
 * machine with no network and no prior install, and keeps these tests from
 * reaching the real registry -- or, on a contributor's own box, from
 * finding the linked dev `twing` and actually bootstrapping into the
 * fixture's fake $HOME. */
function pathWhereBootstrapFails(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twing-enforce-hooks-nobootstrap-"));
  for (const tool of ["twing", "npm", "npx"]) {
    fs.writeFileSync(path.join(dir, tool), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  }
  return `${dir}:${process.env.PATH ?? ""}`;
}

function runScript(cwd: string, home: string, pathOverride?: string): { stdout: string; status: number } {
  try {
    const stdout = execFileSync("sh", ["-c", bootstrapHookScript()], {
      cwd,
      env: { HOME: home, PATH: pathOverride ?? process.env.PATH ?? "" },
    });
    return { stdout: stdout.toString(), status: 0 };
  } catch (err) {
    const e = err as { stdout?: Buffer; status?: number };
    return { stdout: e.stdout?.toString() ?? "", status: e.status ?? 1 };
  }
}

/** A `$HOME` with the twing-hook binary present and/or referenced from
 * `~/.claude/settings.json`. `hookStdout`, when given, is what the fake
 * binary prints -- so a test can prove the script `exec`'d it rather than
 * deciding the verdict itself. */
function fakeHome(hookInstalled: boolean, hookWired: boolean, hookStdout = ""): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "twing-enforce-hooks-home-"));
  if (hookInstalled) {
    const binDir = path.join(home, ".twing", "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const body = hookStdout === "" ? "#!/bin/sh\nexit 0\n" : `#!/bin/sh\nprintf '%s' '${hookStdout}'\n`;
    fs.writeFileSync(path.join(binDir, "twing-hook"), body, { mode: 0o755 });
  }
  if (hookWired) {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: path.join(home, ".twing", "bin", "twing-hook") }] }] } }));
  }
  return home;
}

/** A repo the bootstrap hook considers in scope: a git repo carrying a
 * committed `.twing/twing.yml`. */
function twingRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "twing-enforce-hooks-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  fs.mkdirSync(path.join(repo, ".twing"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".twing", "twing.yml"), "coordinator:\n  serverUrl: http://localhost:9999\n");
  return repo;
}

test("bootstrapHookScript: stands down silently when the hook is already wired globally", () => {
  // The double-fire guard: the global ~/.claude/settings.json entry handles
  // this event, so the committed entry must produce nothing at all. Claude
  // Code runs hooks from every settings scope, so emitting a verdict here
  // too would mean two gate checks per Edit.
  const { stdout, status } = runScript(twingRepo(), fakeHome(true, true));
  assert.equal(status, 0);
  assert.equal(stdout, "", "must emit nothing when global wiring owns this event");
});

test("bootstrapHookScript: execs the installed binary when it exists but isn't wired globally", () => {
  // The steady state on a bootstrapped machine: this committed entry is the
  // only wiring, so it hands the real verdict to the binary rather than
  // deciding anything itself.
  const home = fakeHome(true, false, "VERDICT_FROM_REAL_HOOK");
  const { stdout, status } = runScript(twingRepo(), home);
  assert.equal(status, 0);
  assert.equal(stdout, "VERDICT_FROM_REAL_HOOK", "must exec twing-hook, not synthesize its own verdict");
});

test("bootstrapHookScript: denies with an operational message when bootstrap can't install twing", () => {
  const { stdout, status } = runScript(twingRepo(), fakeHome(false, false), pathWhereBootstrapFails());
  assert.equal(status, 0, "the hook itself must always exit 0 regardless of allow/deny");

  const parsed = JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
  const reason = parsed.hookSpecificOutput.permissionDecisionReason;

  // Reads as a failure report, not an install instruction. The v1/v2
  // message told the agent to run `npm install -g ...`, which a careful
  // agent correctly refuses (it arrives as denied tool output) and which
  // needs sudo on a system-Node box anyway -- so it must not come back.
  assert.ok(!/npm install -g/.test(reason), "must not instruct the agent to install anything itself");
  assert.match(reason, /could not install itself/i);
  assert.match(reason, /operational failure, not a task for you to work around/i);
  assert.match(reason, /https:\/\/twing\.dev/);
  assert.match(reason, /github\.com\/Twing-dev\/twing-cli/);
  assert.match(reason, /gh auth login/, "names the credential twing needs when unattended");
});

// Both scope checks below deliberately use a $HOME with NO global wiring and
// NO binary, and a PATH whose npx always fails: that combination would
// otherwise reach the bootstrap branch and deny. So an empty stdout proves
// the repo-scope check itself returned early, not that a later guard
// happened to mask it.

test("bootstrapHookScript: silent no-op (empty stdout, exit 0) outside a git repo", () => {
  const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "twing-enforce-hooks-notrepo-"));
  const { stdout, status } = runScript(notARepo, fakeHome(false, false), pathWhereBootstrapFails());
  assert.equal(status, 0);
  assert.equal(stdout, "", "not a git repo -- must not even attempt a bootstrap");
});

test("bootstrapHookScript: silent no-op when the repo has no .twing/twing.yml", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "twing-enforce-hooks-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const { stdout, status } = runScript(repo, fakeHome(false, false), pathWhereBootstrapFails());
  assert.equal(status, 0);
  assert.equal(stdout, "", "not a twing repo -- must not even attempt a bootstrap");
});

// --- cross-version upgrade (regression: the v2 -> v3 marker rename) --------
//
// The marker stem changed in v3 (twing-install-enforcement-hook-vN ->
// twing-bootstrap-hook-vN). Matching is by prefix, so an older entry became
// invisible to the upgrade and got appended beside rather than replaced.
// Both then fired, and the stale one denied unconditionally -- v2 requires
// the global wiring that v3's --unattended bootstrap deliberately never
// creates. Running the command meant to fix a repo could brick it.

const V2_MARKER = "# twing-install-enforcement-hook-v2";
const V1_MARKER = "# twing-install-enforcement-hook-v1";

function seedRepoWithHook(marker: string): string {
  const repoRoot = tmpRepoRoot();
  fs.mkdirSync(path.dirname(settingsPath(repoRoot)), { recursive: true });
  fs.writeFileSync(
    settingsPath(repoRoot),
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: `${marker}\n...old script...` }] }] } }),
  );
  return repoRoot;
}

function bootstrapCommands(repoRoot: string): string[] {
  const settings = readSettings(repoRoot);
  return (settings.hooks?.PreToolUse ?? []).flatMap((e) => e.hooks.map((h) => h.command)).filter((c) => KNOWN_BOOTSTRAP_HOOK_MARKERS.some((m) => c.startsWith(m)));
}

for (const [label, marker] of [["v2", V2_MARKER], ["v1", V1_MARKER]] as const) {
  test(`enableInstallEnforcement: upgrades a ${label} entry in place rather than appending beside it`, () => {
    const repoRoot = seedRepoWithHook(marker);
    assert.equal(enableInstallEnforcement(repoRoot), true);

    const hooks = bootstrapCommands(repoRoot);
    assert.equal(hooks.length, 1, `exactly one bootstrap hook must survive -- two would both fire, and the stale ${label} denies unconditionally`);
    assert.equal(hooks[0], bootstrapHookScript());
  });
}

test("enableInstallEnforcement: collapses a repo already broken by the pre-fix upgrade (v2 AND v3 present)", () => {
  // The state a repo lands in if it ran enable-enforcement while the rename
  // bug was live. Re-running must heal it, not preserve the deadlock.
  const repoRoot = tmpRepoRoot();
  fs.mkdirSync(path.dirname(settingsPath(repoRoot)), { recursive: true });
  fs.writeFileSync(
    settingsPath(repoRoot),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: "Edit|Write", hooks: [
            { type: "command", command: `${V2_MARKER}\n...stale deny script...` },
            { type: "command", command: bootstrapHookScript() },
          ]},
        ],
      },
    }),
  );

  assert.equal(enableInstallEnforcement(repoRoot), true, "must report a change -- there is a stale entry to remove");
  const hooks = bootstrapCommands(repoRoot);
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0], bootstrapHookScript());
});

test("isInstallEnforcementWired: recognises an older version's entry", () => {
  // Otherwise `twing project enable-enforcement` would report "already
  // present" or "nothing to remove" about a hook that is plainly there.
  assert.equal(isInstallEnforcementWired(seedRepoWithHook(V2_MARKER)), true);
});

test("disableInstallEnforcement: removes older versions and duplicates too, leaving siblings", () => {
  const repoRoot = tmpRepoRoot();
  fs.mkdirSync(path.dirname(settingsPath(repoRoot)), { recursive: true });
  fs.writeFileSync(
    settingsPath(repoRoot),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: "Edit|Write", hooks: [
            { type: "command", command: "some-other-tool" },
            { type: "command", command: `${V2_MARKER}\n...stale...` },
            { type: "command", command: bootstrapHookScript() },
          ]},
        ],
      },
    }),
  );

  assert.equal(disableInstallEnforcement(repoRoot), true);
  assert.equal(bootstrapCommands(repoRoot).length, 0, "every twing bootstrap hook must go, not just the current one");
  const settings = readSettings(repoRoot);
  const survivors = (settings.hooks?.PreToolUse ?? []).flatMap((e) => e.hooks.map((h) => h.command));
  assert.deepEqual(survivors, ["some-other-tool"], "another tool's hook must survive untouched");
});
