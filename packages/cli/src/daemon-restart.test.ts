/**
 * `twing daemon restart` (daemon-restart.ts). Every assertion here is about
 * the same defect from different angles: a socket-connect probe answers "is
 * anything listening?", which any daemon satisfies -- including the one the
 * restart was supposed to replace. Success has to mean "a *different*
 * process holds the socket now".
 *
 * `DaemonRestartDeps` (init.ts's `InitDeps` convention) stands in for the
 * process signals, detached spawns and socket round
 * trips this can't do for real in a test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runDaemonRestart, type DaemonRestartDeps } from "./daemon-restart.js";
import { type DaemonIdentity } from "./daemon-client.js";
import { captureConsole } from "./test-support.js";

interface FakeWorld {
  /** The daemon currently holding the socket, or null for nothing. */
  holder: { pid: number; version: string } | null;
  /** Set false to model a daemon predating `get_identity` (pre-this-release). */
  answersIdentity: boolean;
  /** Set false to model a daemon predating the `shutdown` message
   * (pre-`@twing/cli@0.2.6`), which never replies to it. */
  answersShutdown: boolean;
  /** Set false to model a wedged daemon that ignores SIGTERM. */
  diesOnSignal: boolean;
  signals: { pid: number; sig: string }[];
  spawns: number;
}

function fakeWorld(overrides: Partial<FakeWorld> = {}): FakeWorld {
  return {
    holder: { pid: 100, version: "0.2.11" },
    answersIdentity: true,
    answersShutdown: true,
    diesOnSignal: true,
    signals: [],
    spawns: 0,
    ...overrides,
  };
}

function depsFor(world: FakeWorld, nextPid = 200): DaemonRestartDeps {
  const start = () => {
    world.holder = { pid: nextPid, version: "0.2.12" };
  };
  return {
    socketPath: "/tmp/fake-twing.sock",
    identity: async (): Promise<DaemonIdentity | null> => (world.holder && world.answersIdentity ? { ...world.holder, startedAt: 0 } : null),
    requestShutdown: async () => {
      if (!world.holder || !world.answersShutdown) return false;
      world.holder = null;
      return true;
    },
    socketAlive: async () => world.holder !== null,
    signal: (pid, sig) => {
      world.signals.push({ pid, sig });
      if (world.diesOnSignal && world.holder?.pid === pid) world.holder = null;
    },
    spawnDaemon: async () => {
      world.spawns++;
      if (!world.holder) {
        start();
        return "started";
      }
      return "already-running";
    },
    // Tests must not spend the production 2s-per-wait budget.
    pollIntervalMs: 1,
  };
}

test("runDaemonRestart: the happy path reports the pid it actually replaced", async () => {
  const world = fakeWorld();
  const { logs } = await captureConsole(() => runDaemonRestart(depsFor(world)));

  assert.equal(world.holder?.pid, 200, "a different process holds the socket now");
  assert.equal(world.spawns, 1);
  assert.match(logs.join("\n"), /restarted \(pid 100 \(0\.2\.11\) -> pid 200 \(0\.2\.12\)\)/);
});

test("runDaemonRestart: throws instead of reporting success when the same pid still holds the socket", async () => {
  const world = fakeWorld();
  // A restart that does nothing at all: every step reports success, the
  // socket stays live, and pid 100 never moves. This is the live incident
  // (GitHub issue #20) in one test -- success is defined as "a *different*
  // process holds the socket now", never "something does".
  // Every step *looks* like it worked -- shutdown is acked, the socket goes
  // quiet, a spawn is reported -- but pid 100 is holding the socket again by
  // the time we check. Only the final "is it a *different* pid" test can
  // catch that; asking whether something is listening cannot.
  let spawned = false;
  const deps: DaemonRestartDeps = {
    ...depsFor(world),
    requestShutdown: async () => true,
    // Gone while we wait for it to leave; back once a "replacement" starts.
    socketAlive: async () => spawned,
    spawnDaemon: async () => {
      spawned = true;
      world.spawns += 1;
      return "already-running";
    },
    // ...but it is the same pid 100 that world.holder still names.
  };

  await assert.rejects(() => runDaemonRestart(deps), /pid 100 is still the daemon holding .* the restart did not take effect/);
});

// Regression: the `shutdown` message only shipped in @twing/cli@0.2.6. An
// older daemon logs `unknown message type` and never replies, so the
// request no-ops -- and `requestDaemonShutdown()`'s return value used to be
// discarded, which made that indistinguishable from a clean shutdown.
test("runDaemonRestart: an old daemon that never acks shutdown is escalated to SIGTERM by pid", async () => {
  const world = fakeWorld({ answersShutdown: false });

  await captureConsole(() => runDaemonRestart(depsFor(world)));

  assert.deepEqual(world.signals, [{ pid: 100, sig: "SIGTERM" }], "the shutdown no-op must escalate, not be trusted");
  assert.equal(world.holder?.pid, 200);
});

test("runDaemonRestart: a daemon that answers neither shutdown nor get_identity fails loudly with a manual-kill instruction", async () => {
  const world = fakeWorld({ answersShutdown: false, answersIdentity: false });

  await assert.rejects(() => runDaemonRestart(depsFor(world)), /too old to answer .* still holds .*lsof/);
  assert.deepEqual(world.signals, [], "never kill a process that couldn't be identified");
  assert.equal(world.spawns, 0, "and never spawn a second daemon behind it");
});

test("runDaemonRestart: a daemon that ignores SIGTERM fails rather than reporting a restart", async () => {
  const world = fakeWorld({ answersShutdown: false, diesOnSignal: false });

  await assert.rejects(() => runDaemonRestart(depsFor(world)), /still holds .* after a shutdown request and SIGTERM/);
});

test("runDaemonRestart: nothing running at all just starts one", async () => {
  const world = fakeWorld({ holder: null });

  const { logs } = await captureConsole(() => runDaemonRestart(depsFor(world)));

  assert.deepEqual(world.signals, []);
  assert.equal(world.spawns, 1);
  assert.equal(world.holder?.pid, 200);
  assert.match(logs.join("\n"), /restarted \(pid 200/);
});

test("runDaemonRestart: throws when nothing comes back up", async () => {
  const world = fakeWorld();
  const deps: DaemonRestartDeps = { ...depsFor(world), spawnDaemon: async () => "failed" };

  await assert.rejects(() => runDaemonRestart(deps), /did not come back up/);
});
