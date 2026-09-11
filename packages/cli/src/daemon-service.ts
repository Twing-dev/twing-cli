/**
 * The daemon launch marker -- `~/.twing/daemon-launch.json`, the `{node,
 * script}` pair every path that starts the daemon agrees on. The Go hook's
 * self-heal (`hook/daemon_launch.go`) reads it and nothing else: it has no
 * way to independently rediscover `daemonMainPath`'s monorepo-relative
 * resolution, especially once `twing-hook` ships as a binary decoupled from
 * the TS package layout.
 *
 * **The OS-level service is gone (was launchd LaunchAgent / systemd --user
 * unit).** It was introduced for restart survival, but it never actually
 * did the job people assumed:
 *
 *  - It could not detect a wedged daemon. `Restart=on-failure` and
 *    `KeepAlive` fire when a process *exits*; a wedged daemon is alive and
 *    still holding the socket, so the service manager saw a healthy unit.
 *  - Reboot survival is already covered. The Go hook self-heals from the
 *    marker below, and the daemon has no work to do between sessions
 *    anyway -- it now exits on idle (`daemon/server.ts`), so "survives a
 *    reboot" stopped being a meaningful property to buy.
 *  - It was the only privileged, environment-sensitive step in `twing
 *    init`: it needs a service manager (absent in containers), and
 *    `loginctl enable-linger` is polkit-gated on some systems. It reliably
 *    produced a scary "install failed" line on machines where nothing was
 *    actually wrong.
 *  - It caused real bugs of its own: the 2026-08-26 socket race where the
 *    systemd instance crash-looped forever underneath a reported
 *    "installed", the 2026-08-22 launchd bootout staleness bug (and the
 *    rollback machinery written to contain it), and issue #20's
 *    stale-plist misreporting.
 *
 * What it uniquely provided was an authority to evict a socket squatter
 * (`TWING_DAEMON_SUPERVISED`). That capability moved to `twing daemon
 * restart` -- see `EVICTION_ENV` in `daemon/server.ts`.
 *
 * `uninstallDaemonService` remains, and is not vestigial: machines that ran
 * an older `twing init` still have a live plist or unit that would keep
 * respawning a daemon outside this scheme. It is how they get cleaned up.
 *
 * `spawn-daemon.ts` depends on this module (for `daemonMainPath`), not the
 * other way around -- keeps the import graph one-directional.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// packages/cli/dist/daemon/main.js -- a sibling of this file
// (daemon-service.js) once built, mirroring the src/daemon/ layout. Was
// previously resolved via require.resolve("@twing/daemon/package.json")
// back when the daemon was a separate npm package; folded into @twing/cli
// directly since it was that package's only consumer.
export function daemonMainPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "daemon", "main.js");
}

/** Where the zero-touch bootstrap installs `@twing/cli` (`enforce-hooks.ts`
 * runs `npm install --prefix` here). Owned by twing, under the developer's
 * own home directory: no elevation needed to write it, and nothing else
 * ever garbage-collects it. */
export function twingLibDir(): string {
  return path.join(os.homedir(), ".twing", "lib");
}

function stableDaemonMainPath(): string {
  return path.join(twingLibDir(), "node_modules", "@twing", "cli", "dist", "daemon", "main.js");
}

/**
 * The daemon entrypoint to record in the launch marker, and to spawn from.
 *
 * Prefers the copy under `~/.twing/lib` when one exists, because the marker
 * has to keep working long after the process that wrote it is gone. A
 * bootstrap run executes inside a short-lived `npx`/`npm exec` process whose
 * own files live in npm's cache (`~/.npm/_npx/<hash>/`), and npm is free to
 * evict that cache whenever it likes -- `npm cache clean`, or simply age.
 * Recording that path yields a marker that works today and silently fails
 * weeks later, which is precisely the failure the marker exists to prevent.
 * It also became much more likely once the daemon started exiting on idle:
 * the marker is now re-read routinely rather than almost never.
 *
 * Falls back to this build's own sibling path -- correct for a global
 * install or a contributor's checkout, where the running copy is already
 * as stable as anything else on the machine.
 */
export function resolveDaemonScript(): string {
  const stable = stableDaemonMainPath();
  return fs.existsSync(stable) ? stable : daemonMainPath();
}

interface DaemonLaunchMarker {
  node: string;
  script: string;
}

function daemonLaunchMarkerPath(): string {
  return path.join(os.homedir(), ".twing", "daemon-launch.json");
}

/** Writes `~/.twing/daemon-launch.json` — the (node, script) pair used to
 * start the daemon, both by `spawn-daemon.ts` and by the Go hook's
 * self-heal fallback. Idempotent, safe to call on every
 * `init`/`ensureDaemonRunning` run (matches those callers' own "safe to
 * re-run" property) — always reflects the *current* build's paths, so a
 * `twing-cli` upgrade that moves `daemon/main.js` is picked up
 * automatically the next time either caller runs. */
export function writeDaemonLaunchMarker(): void {
  const marker: DaemonLaunchMarker = { node: process.execPath, script: resolveDaemonScript() };
  const target = daemonLaunchMarkerPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(marker, null, 2) + "\n");
}

const LAUNCH_AGENT_LABEL = "dev.twing.daemon";

function launchAgentPlistPath(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
}

function systemdUnitPath(): string {
  return path.join(os.homedir(), ".config", "systemd", "user", "twing-daemon.service");
}

export type ServiceUninstallResult = "removed" | "none";

/**
 * Removes a launchd LaunchAgent / systemd unit left by an older `twing
 * init`, stopping the job first so it can't respawn a daemon on its way
 * out. Without this, an upgraded machine keeps a service manager starting
 * daemons outside the current scheme -- including one that would fight the
 * idle-exit behavior by restarting the daemon every time it exits.
 *
 * Best-effort throughout, and never throws: `twing uninstall` must finish
 * the rest of its teardown even where `launchctl`/`systemctl` is missing or
 * the job was already gone. Returns whether a definition file was actually
 * found and removed, so callers can report honestly.
 */
export function uninstallDaemonService(): ServiceUninstallResult {
  let removed = false;

  if (process.platform === "darwin") {
    const plistPath = launchAgentPlistPath();
    if (fs.existsSync(plistPath)) {
      const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
      tolerate(() => execFileSync("launchctl", ["bootout", `gui/${uid ?? ""}/${LAUNCH_AGENT_LABEL}`], { stdio: "ignore" }));
      tolerate(() => fs.unlinkSync(plistPath));
      removed = !fs.existsSync(plistPath);
    }
    return removed ? "removed" : "none";
  }

  if (process.platform === "linux") {
    const unitPath = systemdUnitPath();
    if (fs.existsSync(unitPath)) {
      tolerate(() => execFileSync("systemctl", ["--user", "disable", "--now", "twing-daemon.service"], { stdio: "ignore" }));
      tolerate(() => fs.unlinkSync(unitPath));
      removed = !fs.existsSync(unitPath);
      // Only after the file is gone -- reloading first would just re-read it.
      tolerate(() => execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" }));
    }
    return removed ? "removed" : "none";
  }

  return "none";
}

function tolerate(fn: () => unknown): void {
  try {
    fn();
  } catch {
    // Every step here is "make sure this is gone" -- already-gone, or no
    // service manager to ask, are both fine outcomes.
  }
}
