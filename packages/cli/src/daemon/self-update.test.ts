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
import { performSelfUpdate, isSelfUpdatable, updateTarget, twingLibDir, type SelfUpdateDeps } from "./self-update.js";
import { withHome } from "../test-support.js";

/** A repo on the coordinator being matched -- where init has to run. */
const REPO = "/work/some-repo";

function recordingDeps(overrides: Partial<SelfUpdateDeps> = {}): { deps: SelfUpdateDeps; calls: string[][]; cwds: (string | undefined)[]; logs: string[] } {
  const calls: string[][] = [];
  const cwds: (string | undefined)[] = [];
  const logs: string[] = [];
  return {
    calls,
    cwds,
    logs,
    deps: {
      run: async (command, args, options) => {
        calls.push([command, ...args]);
        cwds.push(options?.cwd);
      },
      cliEntry: (target) => `/fake/${target}/node_modules/@twing/cli/dist/index.js`,
      log: (line) => logs.push(line),
      ...overrides,
    },
  };
}

test("performSelfUpdate: installs the coordinator's exact version, then runs the NEW cli's init", async () => {
  const { deps, calls } = recordingDeps();
  assert.equal(await performSelfUpdate("0.2.18", "managed", deps, { initCwd: REPO }), true);
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

test("performSelfUpdate: a global install is updated with -g, not into the managed prefix", async () => {
  const { deps, calls } = recordingDeps();
  assert.equal(await performSelfUpdate("0.2.18", "global", deps, { initCwd: REPO }), true);

  // `--prefix ~/.twing/lib` here would install a second copy *beside* the
  // `twing` already on PATH, leaving the stale one to keep resolving --
  // the mismatch would survive its own fix.
  assert.ok(calls[0].includes("-g"), `expected a global install, got ${calls[0].join(" ")}`);
  assert.ok(!calls[0].includes("--prefix"), "must not redirect a global install into the managed prefix");

  // And init must run from the copy that was actually replaced.
  assert.ok(calls[1][1].startsWith("/fake/global/"));
});

test("performSelfUpdate: reports failure and skips init when the install fails", async () => {
  const { deps, calls, logs } = recordingDeps({
    run: async (command) => {
      if (command === "npm") throw new Error("network unreachable");
    },
  });
  assert.equal(await performSelfUpdate("0.2.18", "managed", deps, { initCwd: REPO }), false);
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
  assert.equal(await performSelfUpdate("0.2.18", "managed", deps, { initCwd: REPO }), false);
  assert.ok(logs.some((l) => l.includes("init failed")));
});

// Found live 2026-09-30: init ran from the daemon's own cwd, which is not a
// repo, and failed on "no coordinator configured" -- the CLI was updated, the
// hook binary was not, and every edit stayed denied.
test("performSelfUpdate: runs the new CLI's init inside the repo it was given", async () => {
  const { deps, calls, cwds } = recordingDeps();
  assert.equal(await performSelfUpdate("0.2.18", "managed", deps, { initCwd: REPO }), true);
  assert.deepEqual(calls[1].slice(2), ["init", "--unattended"]);
  assert.equal(cwds[1], REPO, "init resolves its coordinator from the repo it runs in");
});

test("performSelfUpdate: with no repo to run init in, starts nothing -- no half update", async () => {
  const { deps, calls, logs } = recordingDeps();
  assert.equal(await performSelfUpdate("0.2.18", "managed", deps), false);
  assert.equal(calls.length, 0, "installing the CLI without refreshing the hook is worse than waiting");
  assert.ok(logs.some((l) => l.includes("no repo on it has been seen yet")));
});

test("performSelfUpdate: installs a prerelease coordinator's exact version", async () => {
  const { deps, calls } = recordingDeps();
  assert.equal(await performSelfUpdate("1.3.13-experimental.1", "managed", deps, { initCwd: REPO }), true);
  assert.ok(calls[0].includes("@twing/cli@1.3.13-experimental.1"), calls[0].join(" "));
});

test("performSelfUpdate: a failure logs the command's own stderr, not just 'Command failed'", async () => {
  const { deps, logs } = recordingDeps({
    run: async (command) => {
      if (command !== "npm") throw Object.assign(new Error("Command failed: node index.js init --unattended"), { stderr: "no coordinator configured for this repo\n" });
    },
  });
  assert.equal(await performSelfUpdate("0.2.18", "managed", deps, { initCwd: REPO }), false);
  assert.ok(logs.some((l) => l.includes("no coordinator configured for this repo") && l.includes(REPO)), logs.join("\n"));
});

test("isSelfUpdatable: true for any install this user can write, managed or global", async () => {
  await withHome(async () => {
    const lib = path.join(twingLibDir(), "node_modules", "@twing", "cli", "dist", "daemon");
    fs.mkdirSync(lib, { recursive: true });
    assert.equal(isSelfUpdatable(`file://${path.join(lib, "self-update.js")}`), true);

    // A global install under the user's own prefix (`~/.npm-global`, nvm,
    // any `npm config set prefix`) needs no sudo either. Excluding these
    // was the bug: those machines kept being told to run three commands by
    // hand for no reason.
    const userGlobal = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "npm-global-")), "dist", "daemon");
    fs.mkdirSync(userGlobal, { recursive: true });
    assert.equal(isSelfUpdatable(`file://${path.join(userGlobal, "self-update.js")}`), true);
  });
});

test("isSelfUpdatable: false when the install is not writable by this user", async () => {
  await withHome(async () => {
    // Stand-in for a root-owned /usr/lib/node_modules: a package root this
    // user cannot write. That is the one case a background daemon must not
    // attempt, since it can never obtain the privilege.
    const readOnly = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "root-owned-")), "cli");
    fs.mkdirSync(path.join(readOnly, "dist", "daemon"), { recursive: true });
    fs.chmodSync(readOnly, 0o555);
    try {
      assert.equal(isSelfUpdatable(`file://${path.join(readOnly, "dist", "daemon", "self-update.js")}`), false);
    } finally {
      fs.chmodSync(readOnly, 0o755); // so the tmpdir can be cleaned up
    }
  });
});

test("isSelfUpdatable: false when there is no install at that path at all", async () => {
  await withHome(async () => {
    assert.equal(isSelfUpdatable(`file://${path.join(os.tmpdir(), "x", "self-update.js")}`), false);
  });
});

test("updateTarget: managed only under ~/.twing/lib, global everywhere else", async () => {
  await withHome(async () => {
    const lib = path.join(twingLibDir(), "node_modules", "@twing", "cli", "dist", "daemon");
    fs.mkdirSync(lib, { recursive: true });
    assert.equal(updateTarget(`file://${path.join(lib, "self-update.js")}`), "managed");

    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "global-"));
    assert.equal(updateTarget(`file://${path.join(elsewhere, "self-update.js")}`), "global");
  });
});
