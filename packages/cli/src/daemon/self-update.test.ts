/**
 * `self-update.ts` -- the daemon replacing a twing-managed install rather
 * than asking the agent to run three commands mid-edit.
 *
 * Subprocesses are injected: the real thing runs `npm install` and a full
 * `init`, neither of which a unit test should perform. What matters here is
 * *which* commands run, in what order, and what happens when one fails.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performSelfUpdate, isSelfUpdatable, twingLibDir, type SelfUpdateDeps } from "./self-update.js";
import { withHome } from "../test-support.js";

function recordingDeps(overrides: Partial<SelfUpdateDeps> = {}): { deps: SelfUpdateDeps; calls: string[][]; logs: string[] } {
  const calls: string[][] = [];
  const logs: string[] = [];
  return {
    calls,
    logs,
    deps: {
      run: async (command, args) => {
        calls.push([command, ...args]);
      },
      cliEntry: () => "/fake/lib/node_modules/@twing/cli/dist/index.js",
      log: (line) => logs.push(line),
      ...overrides,
    },
  };
}

test("performSelfUpdate: installs the coordinator's exact version, then runs the NEW cli's init", async () => {
  const { deps, calls } = recordingDeps();
  assert.equal(await performSelfUpdate("0.2.18", deps), true);
  assert.equal(calls.length, 2);

  // Pinned to the server's version, never @latest: those can differ (a
  // release published but not deployed), and chasing latest would swap one
  // mismatch for another and re-trigger immediately.
  assert.ok(calls[0].includes("@twing/cli@0.2.18"), `expected a pinned install, got ${calls[0].join(" ")}`);
  assert.ok(calls[0].includes("--prefix") && calls[0].includes(twingLibDir()), "must install into the twing-managed prefix");

  // The updated CLI does this, not the running one -- it refreshes the hook
  // binary (whose version the gate actually sends) and the launch marker.
  assert.equal(calls[1][0], process.execPath);
  assert.ok(calls[1][1].endsWith("/dist/index.js"));
  assert.deepEqual(calls[1].slice(2), ["init", "--unattended"]);
});

test("performSelfUpdate: reports failure and skips init when the install fails", async () => {
  const { deps, calls, logs } = recordingDeps({
    run: async (command) => {
      if (command === "npm") throw new Error("network unreachable");
    },
  });
  assert.equal(await performSelfUpdate("0.2.18", deps), false);
  assert.equal(calls.length, 0, "must not run init against a package that failed to install");
  assert.ok(logs.some((l) => l.includes("npm install failed")));
});

test("performSelfUpdate: reports failure when the updated CLI's init fails", async () => {
  const { deps, logs } = recordingDeps({
    run: async (command) => {
      if (command !== "npm") throw new Error("gh auth missing");
    },
  });
  // The package is new but the hook binary and marker were never refreshed,
  // so the daemon must NOT be told the update succeeded.
  assert.equal(await performSelfUpdate("0.2.18", deps), false);
  assert.ok(logs.some((l) => l.includes("init failed")));
});

test("isSelfUpdatable: true only when this code runs from the twing-managed install", async () => {
  await withHome(async () => {
    const lib = path.join(twingLibDir(), "node_modules", "@twing", "cli", "dist", "daemon");
    fs.mkdirSync(lib, { recursive: true });
    assert.equal(isSelfUpdatable(`file://${path.join(lib, "self-update.js")}`), true);

    // A global npm install may need root to replace -- a background daemon
    // cannot obtain that and must not pretend it updated anything.
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "global-"));
    assert.equal(isSelfUpdatable(`file://${path.join(elsewhere, "self-update.js")}`), false);
  });
});

test("isSelfUpdatable: false when there is no managed install at all", async () => {
  await withHome(async () => {
    assert.equal(isSelfUpdatable(`file://${path.join(os.tmpdir(), "x", "self-update.js")}`), false);
  });
});
