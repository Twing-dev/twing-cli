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
 * fresh spawn happens here. */
export async function ensureDaemonRunning(): Promise<"already-running" | "started"> {
  writeDaemonLaunchMarker();
  const socketPath = defaultSocketPath();
  if (await isDaemonRunning(socketPath)) return "already-running";

  const child = spawn(process.execPath, [daemonMainPath()], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return "started";
}
