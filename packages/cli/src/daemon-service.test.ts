/**
 * `resolveDaemonScript`/`writeDaemonLaunchMarker` (daemon-service.ts).
 *
 * The property under test is a durability one: the launch marker has to
 * keep working long after the process that wrote it exits, because the Go
 * hook's self-heal reads it (and reads it routinely now that the daemon
 * exits on idle). A bootstrap runs inside a short-lived `npx`/`npm exec`
 * process living in npm's evictable cache, so recording *that* path yields
 * a marker that works today and silently fails weeks later.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveDaemonScript, daemonMainPath, writeDaemonLaunchMarker, twingLibDir } from "./daemon-service.js";
import { withHome } from "./test-support.js";

/** Stands up the layout `npm install --prefix ~/.twing/lib @twing/cli`
 * produces, which is what the bootstrap hook creates on a fresh machine. */
function seedStableInstall(): string {
  const script = path.join(twingLibDir(), "node_modules", "@twing", "cli", "dist", "daemon", "main.js");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, "// daemon entrypoint\n");
  return script;
}

function readMarker(): { node: string; script: string } {
  return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".twing", "daemon-launch.json"), "utf8"));
}

test("resolveDaemonScript: prefers the stable ~/.twing/lib copy when one exists", async () => {
  await withHome(async () => {
    const stable = seedStableInstall();
    assert.equal(resolveDaemonScript(), stable);
  });
});

test("resolveDaemonScript: falls back to this build's own path when nothing is installed", async () => {
  await withHome(async () => {
    assert.equal(resolveDaemonScript(), daemonMainPath(), "a global install or a checkout is already stable");
  });
});

test("writeDaemonLaunchMarker: records the stable path, never an npm-cache path", async () => {
  await withHome(async () => {
    const stable = seedStableInstall();
    writeDaemonLaunchMarker();

    const marker = readMarker();
    assert.equal(marker.script, stable);
    assert.ok(
      !marker.script.includes("_npx"),
      "a marker into npm's cache works today and silently fails once npm evicts it -- the exact bug this guards",
    );
    assert.equal(marker.node, process.execPath);
  });
});

test("writeDaemonLaunchMarker: the recorded script actually exists on disk", async () => {
  await withHome(async () => {
    seedStableInstall();
    writeDaemonLaunchMarker();
    // Self-heal spawns this path verbatim; a marker naming a missing file is
    // a daemon that never comes back.
    assert.equal(fs.existsSync(readMarker().script), true);
  });
});
