/**
 * `twing daemon restart` -- the remediation half of version-compatibility
 * enforcement (the other half is `npm install -g @twing/cli@latest`). No
 * daemon lifecycle command existed before this; `twing daemon` alone only
 * ever ran it in the foreground.
 *
 * Every check here used to be a bare socket-connect probe, which answers
 * "is anything listening?" and never "is it the process I just started?".
 * That is how a daemon from a local checkout ran 8+ days reporting a stale
 * version while this command printed `twing daemon: restarted` without ever
 * touching it -- only a manual `kill -TERM` worked (GitHub issue #20).
 * Success is now defined as "a *different* process holds the socket than
 * the one that held it before" (`get_identity`, `daemon-client.ts`), and
 * every step that can silently do nothing is checked rather than assumed:
 *
 *  - `requestDaemonShutdown()`'s return value is used. The `shutdown`
 *    message only shipped in `@twing/cli@0.2.6`; an older daemon answers
 *    `unknown message type` and never replies, so the request no-ops -- and
 *    that no-op used to be indistinguishable from a clean shutdown.
 *  - A daemon that won't leave gets `SIGTERM` by pid, which covers that
 *    pre-0.2.6 case by construction: signals need no protocol support.
 *
 * `DaemonRestartDeps` follows `init.ts`'s `InitDeps` convention -- every
 * real side effect here is a process signal, a `launchctl`/`systemctl`
 * subprocess, or a socket round trip, none of which a test can stand up
 * cheaply. Production callers never pass it.
 */

import * as net from "node:net";
import { execFileSync } from "node:child_process";
import { defaultSocketPath } from "@twing/core";
import { isServiceInstalled } from "./daemon-service.js";
import { queryDaemonIdentity, requestDaemonShutdown, type DaemonIdentity } from "./daemon-client.js";
import { ensureDaemonRunning } from "./spawn-daemon.js";

export type ServiceKind = "launchd" | "systemd" | "none";

export interface DaemonRestartDeps {
  socketPath: string;
  serviceKind(): ServiceKind;
  restartService(kind: "launchd" | "systemd"): void;
  identity(): Promise<DaemonIdentity | null>;
  requestShutdown(): Promise<boolean>;
  socketAlive(): Promise<boolean>;
  signal(pid: number, sig: NodeJS.Signals): void;
  spawnDaemon(): Promise<"already-running" | "started" | "failed">;
  /** How long each liveness poll waits between attempts. ~2s total budget
   * in production, same as it has always been. */
  pollIntervalMs: number;
}

function probeSocketAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createConnection(socketPath);
    probe.once("connect", () => {
      probe.end();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

function defaultDeps(): DaemonRestartDeps {
  const socketPath = defaultSocketPath();
  return {
    socketPath,
    serviceKind: isServiceInstalled,
    restartService: (kind) => {
      if (kind === "launchd") {
        const uid = typeof process.getuid === "function" ? process.getuid() : "";
        execFileSync("launchctl", ["kickstart", "-k", `gui/${uid}/dev.twing.daemon`], { stdio: "inherit" });
      } else {
        execFileSync("systemctl", ["--user", "restart", "twing-daemon.service"], { stdio: "inherit" });
      }
    },
    identity: queryDaemonIdentity,
    requestShutdown: requestDaemonShutdown,
    socketAlive: () => probeSocketAlive(socketPath),
    signal: (pid, sig) => process.kill(pid, sig),
    spawnDaemon: ensureDaemonRunning,
    pollIntervalMs: 250,
  };
}

const POLL_ATTEMPTS = 8;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Confirms the old process actually let go of the socket before a
 * replacement is spawned. Returns *whether* it did: the timeout used to be
 * indistinguishable from success, so a daemon that ignored the shutdown
 * request went straight past this into a "restarted" report. */
async function waitForSocketGone(deps: DaemonRestartDeps): Promise<boolean> {
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    if (!(await deps.socketAlive())) return true;
    await sleep(deps.pollIntervalMs);
  }
  return false;
}

/** Waits for a daemon that isn't `notPid` to hold the socket. An
 * unidentified responder satisfies this: it predates identity support, and
 * refusing to guess about such a process is the same stance eviction
 * (`daemon/server.ts`) takes. */
async function waitForFreshDaemon(deps: DaemonRestartDeps, notPid: number | undefined): Promise<boolean> {
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    if (await deps.socketAlive()) {
      if (notPid === undefined) return true;
      const identity = await deps.identity();
      if (!identity || identity.pid !== notPid) return true;
    }
    await sleep(deps.pollIntervalMs);
  }
  return false;
}

/** Last resort when a daemon won't shut down over the socket: signal it by
 * pid. Needs no cooperation from the daemon's protocol, which is the whole
 * point -- the daemons most likely to ignore `shutdown` are the old ones
 * that never understood it. */
async function terminateByPid(deps: DaemonRestartDeps, pid: number): Promise<boolean> {
  try {
    deps.signal(pid, "SIGTERM");
  } catch {
    return true; // already gone -- nothing left to wait for
  }
  return waitForSocketGone(deps);
}

/**
 * Restarts a running daemon, however it was started. Two paths:
 *
 * - An OS-level service (launchd/systemd) is actually loaded: restart it via
 *   the service manager, NOT the socket `shutdown` message. systemd's
 *   `Restart=on-failure` does not respawn on a clean exit code 0, so a
 *   graceful self-shutdown would leave the daemon stopped on Linux; a
 *   service-manager restart SIGTERMs the old process instead, which the
 *   existing signal handler (runDaemonForeground) already handles cleanly.
 * - No service loaded (Windows, install never ran, or a leftover plist for a
 *   job launchd no longer tracks -- see `isServiceInstalled`): socket
 *   `shutdown`, escalating to `SIGTERM` by pid, then the same spawn fallback
 *   `twing init` uses.
 *
 * Either way, finishes by confirming a different process now holds the
 * socket -- never by asking only whether *something* does.
 */
export async function runDaemonRestart(deps: DaemonRestartDeps = defaultDeps()): Promise<void> {
  const before = await deps.identity();
  const kind = deps.serviceKind();

  if (kind !== "none") {
    deps.restartService(kind);
  } else {
    const acked = await deps.requestShutdown();
    // No ack means either nothing was listening (fine) or a daemon too old
    // to understand `shutdown` is still there (not fine) -- one probe tells
    // the two apart without burning the full wait budget on the common case.
    let gone = acked ? await waitForSocketGone(deps) : !(await deps.socketAlive());

    if (!gone) {
      if (!before?.pid) {
        // Listening, didn't ack, and predates identity support -- so there's
        // no pid to signal. Say so, instead of spawning a second daemon that
        // loses the race and lets this report success anyway.
        throw new Error(
          `twing daemon restart: a daemon too old to answer \`shutdown\` or \`get_identity\` still holds ${deps.socketPath}. ` +
            `Find it with \`lsof ${deps.socketPath}\` and kill it manually, then re-run.`,
        );
      }
      gone = await terminateByPid(deps, before.pid);
      if (!gone) {
        throw new Error(`twing daemon restart: pid ${before.pid} still holds ${deps.socketPath} after a shutdown request and SIGTERM -- kill it manually and re-run`);
      }
    }

    await deps.spawnDaemon();
  }

  if (!(await waitForFreshDaemon(deps, before?.pid))) {
    // The two failures are worth telling apart: nothing came back at all,
    // versus the old process never left. The second is the one this whole
    // command exists to stop reporting as success.
    if (before?.pid && (await deps.socketAlive())) {
      throw new Error(`twing daemon restart: pid ${before.pid} is still the daemon holding ${deps.socketPath} -- the restart did not take effect`);
    }
    throw new Error("twing daemon restart: daemon did not come back up within the expected window");
  }

  console.log(`twing daemon: restarted${describe(before, await deps.identity())}`);
}

function describe(before: DaemonIdentity | null, after: DaemonIdentity | null): string {
  if (!after) return ""; // came up but doesn't answer identity yet -- don't invent detail
  const from = before ? `pid ${before.pid} (${before.version}) -> ` : "";
  return ` (${from}pid ${after.pid} (${after.version}))`;
}
