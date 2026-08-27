/**
 * `twing daemon restart` -- the remediation half of version-compatibility
 * enforcement (the other half is `npm install -g @twing/cli@latest`). No
 * daemon lifecycle command existed before this; `twing daemon` alone only
 * ever ran it in the foreground.
 */

import * as net from "node:net";
import { execFileSync } from "node:child_process";
import { defaultSocketPath } from "@twing/core";
import { isServiceInstalled, waitForDaemonUp } from "./daemon-service.js";
import { requestDaemonShutdown } from "./daemon-client.js";
import { ensureDaemonRunning } from "./spawn-daemon.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Inverse of daemon-service.ts's waitForDaemonUp -- confirms the old
 * process actually let go of the socket before spawning a replacement,
 * same ~2s budget. */
async function waitForSocketGone(socketPath: string): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const stillUp = await new Promise<boolean>((resolve) => {
      const probe = net.createConnection(socketPath);
      probe.once("connect", () => {
        probe.end();
        resolve(true);
      });
      probe.once("error", () => resolve(false));
    });
    if (!stillUp) return;
    await sleep(250);
  }
}

/**
 * Restarts a running daemon, however it was started. Two paths:
 *
 * - An OS-level service (launchd/systemd) is installed: restart it via the
 *   service manager directly, NOT the socket `shutdown` message. systemd's
 *   `Restart=on-failure` does not respawn on a clean exit code 0, so a
 *   graceful self-shutdown would leave the daemon stopped on Linux; a
 *   service-manager restart SIGTERMs the old process instead, which the
 *   existing signal handler (runDaemonForeground) already handles cleanly.
 * - No service installed (Windows, or install never ran): socket
 *   `shutdown` message, then the same spawn fallback `twing init` uses.
 *
 * Either way, finishes with a liveness probe before reporting success.
 */
export async function runDaemonRestart(): Promise<void> {
  const kind = isServiceInstalled();
  if (kind === "launchd") {
    const uid = typeof process.getuid === "function" ? process.getuid() : "";
    execFileSync("launchctl", ["kickstart", "-k", `gui/${uid}/dev.twing.daemon`], { stdio: "inherit" });
  } else if (kind === "systemd") {
    execFileSync("systemctl", ["--user", "restart", "twing-daemon.service"], { stdio: "inherit" });
  } else {
    await requestDaemonShutdown();
    await waitForSocketGone(defaultSocketPath());
    await ensureDaemonRunning();
  }

  const up = await waitForDaemonUp(defaultSocketPath());
  if (!up) {
    throw new Error("twing daemon restart: daemon did not come back up within the expected window");
  }
  console.log("twing daemon: restarted");
}
