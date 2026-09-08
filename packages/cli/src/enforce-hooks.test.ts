/**
 * `enforce-hooks.ts` -- the two committed artifacts (`.twing/bootstrap-hook.sh`
 * and the `.claude/settings.json` entries pointing at it), covering both the
 * filesystem merge/dedup logic and real-`sh`-execution of the generated
 * script itself (not just JS-string equality) so actual shell-syntax bugs
 * are caught. See that file's own doc comment for the mechanism.
 */

import { test } from "node:test";
import { withHome } from "./test-support.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  bootstrapHookScript,
  bootstrapScriptPath,
  isBootstrapHook,
  isInstallEnforcementWired,
  enableInstallEnforcement,
  disableInstallEnforcement,
  BOOTSTRAP_HOOK_MARKER,
} from "./enforce-hooks.js";

interface HookCommand {
  type: "command";
  command: string;
  args?: string[];
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

/** Every twing bootstrap hook in the file, any version, across every event
 * -- the shape assertions below are all about which of these exist. */
function bootstrapHooks(repoRoot: string): { event: string; matcher?: string; hook: HookCommand }[] {
  const settings = readSettings(repoRoot);
  const found: { event: string; matcher?: string; hook: HookCommand }[] = [];
  for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
    for (const entry of entries) {
      for (const hook of entry.hooks) {
        if (isBootstrapHook(hook)) found.push({ event, matcher: entry.matcher, hook });
      }
    }
  }
  return found;
}

/** The (event, matcher) pairs wired, sorted for stable comparison. */
function wiredPairs(repoRoot: string): string[] {
  return bootstrapHooks(repoRoot)
    .map(({ event, matcher }) => `${event}:${matcher ?? "-"}`)
    .sort();
}

/** Exactly what the global wiring in `wire-hooks.ts` covers. The two must
 * stay identical: whichever source is authoritative on a machine has to
 * deliver the whole product, and gatsby's incident was precisely what a
 * subset looks like in practice (gate only, no daemon, no capture). */
const EXPECTED_PAIRS = [
  "PostToolUse:Edit|Write|Read|Grep|Glob",
  "PreToolUse:Edit|Write",
  "PreToolUse:ExitPlanMode",
  "SessionEnd:-",
  "SessionStart:-",
  "UserPromptSubmit:-",
].sort();

// --- enableInstallEnforcement / disableInstallEnforcement / isInstallEnforcementWired ---

test("enableInstallEnforcement: writes the script and wires every event the global wiring covers", () => {
  const repoRoot = tmpRepoRoot();
  assert.equal(enableInstallEnforcement(repoRoot), true);
  assert.equal(isInstallEnforcementWired(repoRoot), true);

  assert.deepEqual(wiredPairs(repoRoot), EXPECTED_PAIRS);

  // The script is a committed file, not an inlined JSON string.
  const script = bootstrapScriptPath(repoRoot);
  assert.ok(fs.existsSync(script), "the committed script must be written");
  assert.equal(fs.readFileSync(script, "utf8"), bootstrapHookScript());

  // Every entry points at that file and passes its own event through, which
  // is the only thing the script needs to distinguish them.
  for (const { event, hook } of bootstrapHooks(repoRoot)) {
    assert.equal(hook.command, "sh", "run via sh, so a lost executable bit can't break a clone");
    assert.equal(hook.args?.[0], "${CLAUDE_PROJECT_DIR}/.twing/bootstrap-hook.sh");
    assert.equal(hook.args?.[1], event);
  }
});

test("enableInstallEnforcement: calling it again is a no-op and returns false", () => {
  const repoRoot = tmpRepoRoot();
  enableInstallEnforcement(repoRoot);
  const before = readSettings(repoRoot);
  assert.equal(enableInstallEnforcement(repoRoot), false);
  assert.deepEqual(readSettings(repoRoot), before);
});

test("enableInstallEnforcement: rewrites a script that was edited by hand", () => {
  // The file is regenerated wholesale and says so in its own header; a
  // tampered copy must not survive an admin re-running the command.
  const repoRoot = tmpRepoRoot();
  enableInstallEnforcement(repoRoot);
  fs.writeFileSync(bootstrapScriptPath(repoRoot), "#!/bin/sh\nexit 0\n");
  assert.equal(enableInstallEnforcement(repoRoot), true, "must report a change -- the script was stale");
  assert.equal(fs.readFileSync(bootstrapScriptPath(repoRoot), "utf8"), bootstrapHookScript());
});

test("enableInstallEnforcement: appends into an existing matcher entry instead of creating a duplicate block", () => {
  const repoRoot = tmpRepoRoot();
  fs.mkdirSync(path.dirname(settingsPath(repoRoot)), { recursive: true });
  fs.writeFileSync(
    settingsPath(repoRoot),
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "some-other-tool" }] }] } }),
  );
  enableInstallEnforcement(repoRoot);
  const settings = readSettings(repoRoot);

  const editWrite = (settings.hooks?.PreToolUse ?? []).filter((e) => e.matcher === "Edit|Write");
  assert.equal(editWrite.length, 1, "must not create a second Edit|Write matcher block");
  assert.equal(editWrite[0].hooks.length, 2);
  assert.ok(editWrite[0].hooks.some((h) => h.command === "some-other-tool"), "the other tool's hook survives");
  assert.deepEqual(wiredPairs(repoRoot), EXPECTED_PAIRS);
});

test("disableInstallEnforcement: removes every entry and the script, leaving siblings", () => {
  const repoRoot = tmpRepoRoot();
  fs.mkdirSync(path.dirname(settingsPath(repoRoot)), { recursive: true });
  fs.writeFileSync(
    settingsPath(repoRoot),
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "some-other-tool" }] }] } }),
  );
  enableInstallEnforcement(repoRoot);

  assert.equal(disableInstallEnforcement(repoRoot), true);
  assert.equal(bootstrapHooks(repoRoot).length, 0);
  assert.equal(fs.existsSync(bootstrapScriptPath(repoRoot)), false, "the committed script must go too");

  const settings = readSettings(repoRoot);
  const survivors = Object.values(settings.hooks ?? {}).flatMap((entries) => entries.flatMap((e) => e.hooks.map((h) => h.command)));
  assert.deepEqual(survivors, ["some-other-tool"], "another tool's hook must survive untouched");
});

test("disableInstallEnforcement: drops emptied matcher entries and events entirely", () => {
  const repoRoot = tmpRepoRoot();
  enableInstallEnforcement(repoRoot);
  disableInstallEnforcement(repoRoot);
  const settings = readSettings(repoRoot);
  assert.deepEqual(settings.hooks, {}, "nothing of ours should be left behind, not even empty arrays");
});

test("disableInstallEnforcement: no-op (returns false) when nothing is wired", () => {
  assert.equal(disableInstallEnforcement(tmpRepoRoot()), false);
});

test("isInstallEnforcementWired: false before enabling, true after", () => {
  const repoRoot = tmpRepoRoot();
  assert.equal(isInstallEnforcementWired(repoRoot), false);
  enableInstallEnforcement(repoRoot);
  assert.equal(isInstallEnforcementWired(repoRoot), true);
});

// --- the generated script itself, run through a real `sh -c` ------------------

/** A PATH that still has the real tools (`git` especially) but where every
 * route the bootstrap could take is stubbed to fail: an existing `twing`,
 * and `npm`. Stands in for a machine with no network and no prior install,
 * and keeps these tests from reaching the real registry -- or, on a
 * contributor's own box, from finding the linked dev `twing` and actually
 * bootstrapping into the fixture's fake $HOME. */
function pathWhereBootstrapFails(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twing-enforce-hooks-nobootstrap-"));
  for (const tool of ["twing", "npm", "npx"]) {
    // Fails *loudly*, on stderr, the way the real tools do. v3 sent all of
    // this to /dev/null, which threw away the one actionable line (`gh auth
    // login` is the common one) and left the deny message guessing at three
    // possible causes -- so "the output reached the log" is the property
    // worth asserting, and a silently-failing stub could not prove it.
    fs.writeFileSync(path.join(dir, tool), `#!/bin/sh\necho '${tool}: simulated failure' >&2\nexit 1\n`, { mode: 0o755 });
  }
  return `${dir}:${process.env.PATH ?? ""}`;
}

/** Runs the script the way a wired entry does: `sh <script> <event>`. The
 * event arrives as `$1`, which is the only thing distinguishing the six
 * committed entries from each other. */
function runScript(cwd: string, home: string, event = "PreToolUse", pathOverride?: string): { stdout: string; status: number } {
  try {
    const stdout = execFileSync("sh", ["-c", bootstrapHookScript(), "twing-bootstrap-hook", event], {
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
  // too would mean two gate checks per Edit. This is also the whole of what
  // a developer who installed twing themselves experiences.
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

test("bootstrapHookScript: execs the binary without consulting git, in any directory", () => {
  // The steady-state path deliberately skips `git rev-parse` and the
  // twing.yml check: at six wired events it runs on every Read/Grep/Glob
  // too, and the binary already resolves the coordinator itself and exits
  // silently when there is none. A plain directory stands in for "git would
  // have said no".
  const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "twing-enforce-hooks-notrepo-"));
  const { stdout } = runScript(notARepo, fakeHome(true, false, "VERDICT_FROM_REAL_HOOK"));
  assert.equal(stdout, "VERDICT_FROM_REAL_HOOK");
});

test("bootstrapHookScript: denies with an operational message when bootstrap can't install twing", () => {
  const { stdout, status } = runScript(twingRepo(), fakeHome(false, false), "PreToolUse", pathWhereBootstrapFails());
  assert.equal(status, 0, "the hook itself must always exit 0 regardless of allow/deny");

  const parsed = JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
  const reason = parsed.hookSpecificOutput.permissionDecisionReason;

  // Reads as a failure report, not an install instruction. The v1/v2
  // message told the agent to run `npm install -g ...`, which a careful
  // agent correctly refuses (it arrives as denied tool output) and which
  // needs sudo on a system-Node box anyway -- so it must not come back.
  assert.ok(!/npm install/.test(reason), "must not instruct the agent to install anything itself");
  assert.ok(!/twing (init|login|daemon|design|uninstall)/.test(reason), "must name no twing command -- installing twing is not the agent's job");
  assert.match(reason, /could not install itself/i);
  assert.match(reason, /operational failure, not a task for you to work around/i);
  assert.match(reason, /https:\/\/twing\.dev/);
  assert.match(reason, /github\.com\/Twing-dev\/twing-cli/);
  assert.match(reason, /gh auth login/, "names the credential twing needs when unattended");
});

test("bootstrapHookScript: a failed bootstrap logs the real error rather than discarding it", () => {
  // The deny message tells the reader to go read this log instead of
  // guessing, so the log actually has to have something in it.
  const home = fakeHome(false, false);
  runScript(twingRepo(), home, "PreToolUse", pathWhereBootstrapFails());
  const log = fs.readFileSync(path.join(home, ".twing", "bootstrap.log"), "utf8");
  assert.match(log, /=== twing bootstrap /, "must record the attempt");
  assert.match(log, /simulated failure/, "the tool's own stderr must reach the log, not /dev/null");
});

for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "SessionEnd"]) {
  test(`bootstrapHookScript: ${event} stays silent when bootstrap fails`, () => {
    // Only PreToolUse can carry a permissionDecision. Emitting that JSON
    // for any other event would be output Claude Code has no meaning for,
    // which is why the event is passed in as $1 at all.
    const { stdout, status } = runScript(twingRepo(), fakeHome(false, false), event, pathWhereBootstrapFails());
    assert.equal(status, 0);
    assert.equal(stdout, "", `${event} has no verdict to give -- it must emit nothing`);
  });
}

// Both scope checks below deliberately use a $HOME with NO global wiring and
// NO binary, and a PATH where the bootstrap always fails: that combination
// would otherwise reach the bootstrap branch and deny. So an empty stdout
// proves the repo-scope check itself returned early, not that a later guard
// happened to mask it.

test("bootstrapHookScript: silent no-op (empty stdout, exit 0) outside a git repo", () => {
  const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "twing-enforce-hooks-notrepo-"));
  const { stdout, status } = runScript(notARepo, fakeHome(false, false), "PreToolUse", pathWhereBootstrapFails());
  assert.equal(status, 0);
  assert.equal(stdout, "", "not a git repo -- must not even attempt a bootstrap");
});

test("bootstrapHookScript: silent no-op when the repo has no .twing/twing.yml", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "twing-enforce-hooks-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const { stdout, status } = runScript(repo, fakeHome(false, false), "PreToolUse", pathWhereBootstrapFails());
  assert.equal(status, 0);
  assert.equal(stdout, "", "not a twing repo -- must not even attempt a bootstrap");
});

// --- cross-version upgrade (regression: the v2 -> v3 marker rename) --------
//
// The marker stem changed in v3 (twing-install-enforcement-hook-vN ->
// twing-bootstrap-hook-vN). Matching is by prefix, so an older entry became
// invisible to the upgrade and got appended beside rather than replaced.
// Both then fired, and the stale one denied unconditionally -- v2 requires
// the global wiring that the --unattended bootstrap deliberately never
// creates. Running the command meant to fix a repo could brick it.
//
// v3 -> v4 changes shape as well as marker (one inlined entry becomes six
// file-based ones), so it is the same hazard with more room to go wrong.

const V3_MARKER = "# twing-bootstrap-hook-v3";
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

for (const [label, marker] of [["v3", V3_MARKER], ["v2", V2_MARKER], ["v1", V1_MARKER]] as const) {
  test(`enableInstallEnforcement: replaces a ${label} entry rather than appending beside it`, () => {
    const repoRoot = seedRepoWithHook(marker);
    assert.equal(enableInstallEnforcement(repoRoot), true);

    const hooks = bootstrapHooks(repoRoot);
    assert.equal(hooks.length, 6, `the ${label} entry must be replaced by the current set, not left to fire alongside it`);
    assert.deepEqual(wiredPairs(repoRoot), EXPECTED_PAIRS);
    assert.ok(
      !hooks.some((h) => h.hook.command.startsWith(marker)),
      `no ${label} entry may survive -- a stale one denies unconditionally`,
    );
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
            { type: "command", command: `${V3_MARKER}\n...previous script...` },
          ]},
        ],
      },
    }),
  );

  assert.equal(enableInstallEnforcement(repoRoot), true, "must report a change -- there are stale entries to remove");
  assert.equal(bootstrapHooks(repoRoot).length, 6);
  assert.deepEqual(wiredPairs(repoRoot), EXPECTED_PAIRS);
});

test("isInstallEnforcementWired: recognises an older version's entry", () => {
  // Otherwise `twing project enable-enforcement` would report "already
  // present" or "nothing to remove" about a hook that is plainly there.
  assert.equal(isInstallEnforcementWired(seedRepoWithHook(V2_MARKER)), true);
  assert.equal(isInstallEnforcementWired(seedRepoWithHook(V3_MARKER)), true);
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
            { type: "command", command: `${V3_MARKER}\n...previous...` },
          ]},
        ],
      },
    }),
  );

  assert.equal(disableInstallEnforcement(repoRoot), true);
  assert.equal(bootstrapHooks(repoRoot).length, 0, "every twing bootstrap hook must go, not just the current one");
  const settings = readSettings(repoRoot);
  const survivors = Object.values(settings.hooks ?? {}).flatMap((entries) => entries.flatMap((e) => e.hooks.map((h) => h.command)));
  assert.deepEqual(survivors, ["some-other-tool"], "another tool's hook must survive untouched");
});

test("bootstrapHookScript: carries the current marker, so a future version can find and replace it", () => {
  assert.ok(bootstrapHookScript().includes(BOOTSTRAP_HOOK_MARKER));
});

// --- home-directory guard ----------------------------------------------------

test("enableInstallEnforcement: refuses to write into a repo rooted at $HOME", async () => {
  // A dotfiles repo makes $HOME a git root, and .claude/settings.json there
  // IS the machine-global file. Writing the bootstrap hook to it would fire
  // for every repo on the machine rather than the one being enabled -- the
  // likely way a bootstrap hook was found in a global settings file live.
  await withHome(async (home) => {
    assert.throws(() => enableInstallEnforcement(home), /refusing to write the bootstrap hook into your home directory/);
    assert.equal(fs.existsSync(path.join(home, ".claude", "settings.json")), false, "must not have written anything");
    assert.equal(fs.existsSync(path.join(home, ".twing", "bootstrap-hook.sh")), false, "not the script either");
  });
});

test("enableInstallEnforcement: still works for a normal repo under $HOME", async () => {
  await withHome(async (home) => {
    const repo = path.join(home, "projects", "widgets");
    fs.mkdirSync(repo, { recursive: true });
    assert.equal(enableInstallEnforcement(repo), true);
    assert.equal(isInstallEnforcementWired(repo), true);
  });
});
