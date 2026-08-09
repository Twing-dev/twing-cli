/**
 * Starts the daemon (§6 step 4). Installed as a persistent OS-level service
 * where the platform supports it is "the primary path" per the design doc
 * (§5) -- not implemented here (no systemd/launchd unit generation yet).
 * This implements the doc's own fallback: "a detached background process
 * otherwise." Persistent-service installation is a follow-up, not a
 * silent omission.
 */

import { spawn } from "node:child_process";
import * as net from "node:net";
import { createRequire } from "node:module";
import * as path from "node:path";
import { defaultSocketPath } from "@twing/core";

const require = createRequire(import.meta.url);

function daemonMainPath(): string {
  const pkgJsonPath = require.resolve("@twing/daemon/package.json");
  return path.join(path.dirname(pkgJsonPath), "dist", "main.js");
}

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
 * `twing init` in a second repo reuses it rather than spawning a duplicate. */
export async function ensureDaemonRunning(): Promise<"already-running" | "started"> {
  const socketPath = defaultSocketPath();
  if (await isDaemonRunning(socketPath)) return "already-running";

  const child = spawn(process.execPath, [daemonMainPath()], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return "started";
}
