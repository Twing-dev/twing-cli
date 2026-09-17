/**
 * `twing init --ghuser` -- the one command a developer runs.
 *
 * What matters here is mostly what it *doesn't* do: it installs nothing (the
 * coordinator decides the version, and none is known yet), and it never
 * deletes the copy of itself that is running.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { withHome, captureConsole } from "./test-support.js";
import { runGhUser, autoManagedMarkerPath, runningFromGlobalInstall } from "./ghuser.js";
import { isResolverWired, resolverPath } from "./resolve-hook.js";
import { twingLibDir } from "./daemon/self-update.js";
import { isOpenCodePluginWired } from "./opencode-plugin.js";

function settingsPath(home: string): string {
  return path.join(home, ".claude", "settings.json");
}

test("runGhUser: wires the resolver, and installs nothing at all", async () => {
  // A machine that never opens a twing repo should download nothing. The
  // version to install isn't knowable until a coordinator is, so the install
  // waits for the first session that opens one.
  await withHome(async (home) => {
    await captureConsole(async () => runGhUser({ githubToken: () => "gh-token", uninstallGlobal: () => true }));

    assert.equal(isResolverWired(settingsPath(home)), true);
    assert.ok(fs.existsSync(resolverPath()));
    assert.equal(isOpenCodePluginWired(), true, "same wiring as the one-step install, OpenCode included");
    assert.equal(fs.existsSync(twingLibDir()), false, "must not npm install anything");
    assert.equal(fs.existsSync(path.join(home, ".twing", "bin", "twing-hook")), false, "must not fetch the binary");
  });
});

test("runGhUser: refuses without a GitHub credential, naming the command that fixes it", async () => {
  await withHome(async () => {
    await assert.rejects(
      async () => captureConsole(async () => runGhUser({ githubToken: () => undefined, uninstallGlobal: () => true })),
      /gh auth login/,
    );
  });
});

test("runGhUser: a removed global install leaves no auto-managed marker", async () => {
  // Nothing to disambiguate: one copy, and managedInstall() is already true
  // without help.
  await withHome(async () => {
    // Run this suite from the repo (`npm test`), never `npm --prefix <repo> run
    // test`: `--prefix` sets npm's *global* prefix too, so `npm prefix -g`
    // answers with the repo root, which really is an ancestor of the copy under
    // test -- and this test legitimately fails.
    await captureConsole(async () => runGhUser({ githubToken: () => "t", uninstallGlobal: () => true }));
    assert.equal(fs.existsSync(autoManagedMarkerPath()), false);
  });
});

test("runningFromGlobalInstall: an empty npm prefix is no prefix, not a prefix of everything", () => {
  // `fs.realpathSync("")` returns the *current directory* rather than throwing,
  // so an empty `npm prefix -g` would otherwise read as "twing is running from
  // the global install" for any copy below cwd -- which skips the global
  // uninstall and marks the machine auto-managed over an install that is not
  // there. Hardening, not a fix for an observed failure.
  assert.equal(runningFromGlobalInstall(""), false);
  assert.equal(runningFromGlobalInstall(undefined), false);
  assert.equal(runningFromGlobalInstall("/no/such/prefix/anywhere"), false, "an unresolvable prefix is not ours either");
});

test("runGhUser: a surviving global install gets a marker and a runnable cleanup command", async () => {
  // The marker is what keeps managedInstall() true despite a `twing` on PATH,
  // so the machine carries on auto-updating instead of silently opting out.
  await withHome(async () => {
    const { logs } = await captureConsole(async () => runGhUser({ githubToken: () => "t", uninstallGlobal: () => false }));

    assert.ok(fs.existsSync(autoManagedMarkerPath()), "must record that this machine opted into auto-management");
    const output = logs.join("\n");
    assert.match(output, /npm uninstall -g @twing\/cli/, "must name the cleanup command");
    assert.match(output, /twing no longer uses it/, "must say the leftover is no longer authoritative");
    // The silent trap worth warning about: a hand-typed `twing` still resolves
    // via PATH, and the CLI sends no version header, so the skew is invisible.
    assert.match(output, /typing `twing` yourself/);
  });
});

test("runGhUser: replaces pre-existing twing-hook entries rather than sitting beside them", async () => {
  // A machine that ran `twing init` before this existed has binary-path
  // entries wired. Leaving those *and* the resolver would fire both for every
  // tool call -- two gate checks per edit.
  await withHome(async (home) => {
    const settings = settingsPath(home);
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    const hookPath = path.join(home, ".twing", "bin", "twing-hook");
    fs.writeFileSync(
      settings,
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: hookPath }] }],
          SessionStart: [{ hooks: [{ type: "command", command: hookPath }] }],
        },
      }),
    );

    await captureConsole(async () => runGhUser({ githubToken: () => "t", uninstallGlobal: () => true }));

    const raw = fs.readFileSync(settings, "utf8");
    assert.ok(!raw.includes(`"${hookPath}"`), "the old binary-path entries must be gone");
    assert.equal(isResolverWired(settings), true);
  });
});

test("runGhUser: is idempotent", async () => {
  await withHome(async (home) => {
    await captureConsole(async () => runGhUser({ githubToken: () => "t", uninstallGlobal: () => true }));
    const first = fs.readFileSync(settingsPath(home), "utf8");
    const { logs } = await captureConsole(async () => runGhUser({ githubToken: () => "t", uninstallGlobal: () => true }));
    assert.equal(fs.readFileSync(settingsPath(home), "utf8"), first);
    assert.match(logs.join("\n"), /nothing to change/);
  });
});
