/**
 * Starts the daemon (§6 step 4), and writes the launch marker
 * `daemon-service.ts`'s `installDaemonService` (persistent OS-level
 * service, "the primary path" per the design doc §5) and the Go hook's
 * self-heal (`hook/daemon_launch.go`) both depend on -- so every path that
 * can bring the daemon up agrees on how. This function itself is the
 * doc's documented fallback: "a detached background process otherwise,"
 * for machines/platforms with no service installed.
 */

import { spawn } from "node:child_process";
import * as net from "node:net";
import { defaultSocketPath } from "@twing/core";
import { daemonMainPath, writeDaemonLaunchMarker } from "./daemon-service.js";

function isDaemonRunning(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createConnection(socketPath);
    probe.once("connect", () => {
      probe.end();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

/** No-ops if a daemon is already listening on the socket -- re-running
 * `twing init` in a second repo reuses it rather than spawning a duplicate.
 * Always (re)writes the launch marker first, even on the already-running
 * path -- keeps it current with this build's paths regardless of whether a
 * fresh spawn happens here.
 *
 * Returns `"failed"` when the child dies during startup instead of coming
 * up. This used to be pure fire-and-forget with no `exit`/`error` listener
 * at all, so a daemon that crashed on launch -- `clearStaleSocket` throwing
 * against a squatter is the realistic case -- was reported as `"started"`
 * to `init` and to `daemon restart` alike, and nobody found out until the
 * next symptom, days later. */
export async function ensureDaemonRunning(): Promise<"already-running" | "started" | "failed"> {
  writeDaemonLaunchMarker();
  const socketPath = defaultSocketPath();
  if (await isDaemonRunning(socketPath)) return "already-running";

  const child = spawn(process.execPath, [daemonMainPath()], {
    detached: true,
    stdio: "ignore",
  });

  // Watch just long enough to catch a startup failure. A healthy daemon
  // binds its socket in well under this; an unhealthy one exits almost
  // immediately, so neither outcome actually waits the full budget. The
  // child is unref'd either way, so a caller that exits first never hangs
  // on it.
  const outcome = await new Promise<"started" | "failed">((resolve) => {
    const settle = (result: "started" | "failed") => {
      clearInterval(poll);
      clearTimeout(deadline);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      resolve(result);
    };
    const onError = () => settle("failed");
    const onExit = () => settle("failed");
    child.once("error", onError);
    child.once("exit", onExit);
    const poll = setInterval(() => {
      void isDaemonRunning(socketPath).then((up) => {
        if (up) settle("started");
      });
    }, 100);
    // Neither up nor dead within the budget: report "started" rather than
    // "failed" -- a slow-starting daemon that is still alive is not a
    // failure, and the callers that need certainty (daemon-restart.ts)
    // confirm by identity afterwards regardless.
    const deadline = setTimeout(() => settle("started"), 2_000);
  });

  child.unref();
  return outcome;
}
