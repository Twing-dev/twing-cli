/**
 * `twing uninstall` (uninstall.ts) -- machine-local teardown. Exercised
 * against a real isolated `$HOME` rather than mocks: what matters is which
 * files actually survive, and the one hard rule (never touch a repo's
 * committed settings) is a filesystem fact.
 *
 * No daemon runs in these tests, so `stopDaemon` takes its
 * nothing-listening path -- the socket round trip itself is covered by
 * daemon-restart.test.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runUninstall } from "./uninstall.js";
import { wireHooks } from "./wire-hooks.js";
import { enableInstallEnforcement } from "./enforce-hooks.js";
import { withHome, captureConsole } from "./test-support.js";

/** A `$HOME` that looks like a machine `twing init` has run on. */
function seedInstalledMachine(): { hookPath: string } {
  const hookPath = path.join(os.homedir(), ".twing", "bin", "twing-hook");
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  fs.writeFileSync(hookPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(os.homedir(), ".twing", "config.json"), JSON.stringify({ servers: {} }));
  wireHooks(hookPath);
  return { hookPath };
}

test("runUninstall: removes ~/.twing and twing's global hook entries", async () => {
  await withHome(async (home) => {
    seedInstalledMachine();
    await captureConsole(() => runUninstall());

    assert.equal(fs.existsSync(path.join(home, ".twing")), false, "the binary, cached tokens and gate overrides all live here");

    const settings = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8")) as {
      hooks?: Record<string, { hooks: { command: string }[] }[]>;
    };
    const remaining = Object.values(settings.hooks ?? {}).flat();
    assert.deepEqual(remaining, [], "hook entries pointing at a deleted binary would break every tool call");
  });
});

test("runUninstall: never touches a repo's committed .claude/settings.json", async () => {
  await withHome(async () => {
    seedInstalledMachine();

    // A repo that commits the bootstrap hook. That file is shared team
    // state under version control -- removing it is an admin's decision
    // (`twing project disable-enforcement`), not a side effect of one
    // developer cleaning up their own machine.
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "twing-uninstall-repo-"));
    enableInstallEnforcement(repo);
    const repoSettings = path.join(repo, ".claude", "settings.json");
    const before = fs.readFileSync(repoSettings, "utf8");

    await captureConsole(() => runUninstall());

    assert.equal(fs.readFileSync(repoSettings, "utf8"), before, "the committed hook must survive byte-for-byte");
  });
});

test("runUninstall: is safe to run on a machine that never installed twing", async () => {
  await withHome(async (home) => {
    const { logs } = await captureConsole(() => runUninstall());
    assert.ok(logs.some((l) => l.includes("no running daemon to stop")));
    assert.ok(logs.some((l) => l.includes("no twing hook entries")));
    assert.equal(fs.existsSync(path.join(home, ".twing")), false);
  });
});

test("runUninstall --dry-run: reports without removing anything", async () => {
  await withHome(async (home) => {
    const { hookPath } = seedInstalledMachine();
    const { logs } = await captureConsole(() => runUninstall({ dryRun: true }));

    assert.equal(fs.existsSync(hookPath), true, "--dry-run must not remove the binary");
    assert.ok(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8").includes(hookPath), "--dry-run must not unwire hooks");
    assert.ok(logs.some((l) => l.includes("would remove")));
    assert.ok(logs.some((l) => l.includes("would NOT touch any repo")));
  });
});
