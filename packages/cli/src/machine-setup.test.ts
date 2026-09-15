/**
 * The one-step install's setup must leave a machine exactly where
 * `twing init --ghuser` does, minus the GitHub check: resolver wired, OpenCode
 * wired, managed, and nothing installed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { runMachineSetup, autoManagedMarkerPath } from "./machine-setup.js";
import { isResolverWired, resolverPath } from "./resolve-hook.js";
import { isOpenCodePluginWired, openCodeAdapterPath, openCodePluginPath } from "./opencode-plugin.js";
import { twingLibDir } from "./daemon/self-update.js";
import { withHome, captureConsole } from "./test-support.js";

function settingsPath(home: string): string {
  return path.join(home, ".claude", "settings.json");
}

test("runMachineSetup: wires Claude and OpenCode, marks the machine managed, installs nothing", async () => {
  await withHome(async (home) => {
    await captureConsole(async () => runMachineSetup());

    assert.equal(isResolverWired(settingsPath(home)), true);
    assert.ok(fs.existsSync(resolverPath()));
    assert.equal(isOpenCodePluginWired(), true);
    assert.ok(fs.existsSync(openCodeAdapterPath()));
    // The copy running setup lives outside ~/.twing; without the marker it
    // would make managedInstall() false and switch off version recovery.
    assert.ok(fs.existsSync(autoManagedMarkerPath()));
    assert.equal(fs.existsSync(twingLibDir()), false, "the coordinator picks the version; nothing to install yet");
    assert.equal(fs.existsSync(path.join(home, ".twing", "bin", "twing-hook")), false);
  });
});

test("runMachineSetup: replaces binary-path entries from an earlier twing init", async () => {
  await withHome(async (home) => {
    const hookPath = path.join(home, ".twing", "bin", "twing-hook");
    fs.mkdirSync(path.dirname(settingsPath(home)), { recursive: true });
    fs.writeFileSync(settingsPath(home), JSON.stringify({
      hooks: { PreToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: hookPath }] }] },
    }));

    await captureConsole(async () => runMachineSetup());

    assert.ok(!fs.readFileSync(settingsPath(home), "utf8").includes(`"${hookPath}"`));
    assert.equal(isResolverWired(settingsPath(home)), true);
  });
});

test("runMachineSetup: is idempotent", async () => {
  await withHome(async (home) => {
    await captureConsole(async () => runMachineSetup());
    const first = fs.readFileSync(settingsPath(home), "utf8");
    const { logs } = await captureConsole(async () => runMachineSetup());
    assert.equal(fs.readFileSync(settingsPath(home), "utf8"), first);
    assert.match(logs.join("\n"), /nothing to change/);
  });
});

test("runMachineSetup: a foreign OpenCode twing.js doesn't fail the Claude wiring", async () => {
  await withHome(async (home) => {
    fs.mkdirSync(path.dirname(openCodePluginPath()), { recursive: true });
    fs.writeFileSync(openCodePluginPath(), "// someone else's\n");
    await captureConsole(async () => runMachineSetup());
    assert.equal(isResolverWired(settingsPath(home)), true);
    assert.equal(fs.readFileSync(openCodePluginPath(), "utf8"), "// someone else's\n");
  });
});
