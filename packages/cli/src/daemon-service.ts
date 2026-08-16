/**
 * Restart survival for the daemon (§5's "primary path" — a persistent
 * OS-level service — documented from the start but never built until now;
 * see `spawn-daemon.ts`'s header comment for the detached-process fallback
 * this complements, not replaces).
 *
 * Two things live here: `daemonMainPath`/`writeDaemonLaunchMarker` (the
 * launch marker `~/.twing/daemon-launch.json` is the one thing the Go
 * hook's self-heal, `hook/daemon_launch.go`, needs to know to start the
 * daemon itself — it has no way to independently rediscover
 * `daemonMainPath`'s monorepo-relative resolution, especially once
 * `twing-hook` ships as a binary decoupled from the TS package layout),
 * and `installDaemonService` (best-effort launchd/systemd install).
 *
 * `spawn-daemon.ts` depends on this module (for `daemonMainPath`), not the
 * other way around — keeps the import graph one-directional.
 *
 * Always best-effort: never throws, same philosophy as `init.ts`'s
 * `seedConstraints` ("don't fail `init` over something optional"). A
 * failure here just means the detached-spawn fallback and hook self-heal
 * are the only restart-survival story on this machine — never a reason to
 * abort `init`.
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

interface DaemonLaunchMarker {
  node: string;
  script: string;
}

function daemonLaunchMarkerPath(): string {
  return path.join(os.homedir(), ".twing", "daemon-launch.json");
}

/** Writes `~/.twing/daemon-launch.json` — the (node, script) pair used to
 * start the daemon, both by this machine's OS-service definitions
 * (below) and by the Go hook's self-heal fallback. Idempotent, safe to
 * call on every `init`/`ensureDaemonRunning` run (matches those callers'
 * own "safe to re-run" property) — always reflects the *current* build's
 * paths, so a `twing-cli` upgrade that moves `daemon/main.js` is picked up
 * automatically the next time either caller runs. */
export function writeDaemonLaunchMarker(): void {
  const marker: DaemonLaunchMarker = { node: process.execPath, script: daemonMainPath() };
  const target = daemonLaunchMarkerPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(marker, null, 2) + "\n");
}

export type ServiceInstallResult = "installed" | "unsupported" | "failed";

const LAUNCH_AGENT_LABEL = "dev.twing.daemon";

function launchAgentPlistPath(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
}

function daemonLogPath(): string {
  return path.join(os.homedir(), ".twing", "daemon.log");
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** macOS: a per-user LaunchAgent (never a LaunchDaemon — those run
 * system-wide and need root; a LaunchAgent needs neither elevation nor any
 * account/registration to install). `RunAtLoad` covers "comes back after a
 * reboot," `KeepAlive` covers "comes back after a crash." */
function installLaunchAgent(marker: DaemonLaunchMarker): ServiceInstallResult {
  const plistPath = launchAgentPlistPath();
  const log = daemonLogPath();
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xmlEscape(marker.node)}</string><string>${xmlEscape(marker.script)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xmlEscape(log)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(log)}</string>
</dict>
</plist>
`;
  try {
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, plist);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    try {
      execFileSync("launchctl", ["bootstrap", `gui/${uid ?? ""}`, plistPath], { stdio: "ignore" });
    } catch {
      // Already bootstrapped (most common re-run case) or a transient
      // launchctl error -- tolerate either way. The plist itself is
      // written regardless, so a manual `launchctl bootstrap` still works.
    }
    return "installed";
  } catch {
    return "failed";
  }
}

function systemdUnitPath(): string {
  return path.join(os.homedir(), ".config", "systemd", "user", "twing-daemon.service");
}

/** Linux: a systemd `--user` unit, also needing no elevation. `Restart=
 * on-failure` covers crashes; `enable --now` covers "starts on next
 * login." Reboot-before-any-login also needs `loginctl enable-linger`,
 * attempted best-effort — some systems polkit-gate that to admins, and a
 * failure there still leaves the unit correctly auto-restarting/restarting
 * around every login/crash, just not literally at boot with nobody logged
 * in yet. */
function installSystemdUnit(marker: DaemonLaunchMarker): ServiceInstallResult {
  const unitPath = systemdUnitPath();
  const unit = `[Unit]
Description=twing daemon

[Service]
ExecStart=${marker.node} ${marker.script}
Restart=on-failure

[Install]
WantedBy=default.target
`;
  try {
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    fs.writeFileSync(unitPath, unit);
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    execFileSync("systemctl", ["--user", "enable", "--now", "twing-daemon.service"], { stdio: "ignore" });
    try {
      execFileSync("loginctl", ["enable-linger", os.userInfo().username], { stdio: "ignore" });
    } catch {
      // Best-effort, see doc comment above.
    }
    return "installed";
  } catch {
    return "failed";
  }
}

/** Best-effort OS-level service install so the daemon survives a machine
 * restart without anyone re-running `twing init`/`twing daemon` (§5's
 * "primary path," never built until now). Never throws -- a failure here
 * must not fail `init`; the detached-spawn fallback (`ensureDaemonRunning`)
 * and hook self-heal (`hook/daemon_launch.go`, driven by the same marker
 * file this always writes first) still cover restart-survival either way.
 * Windows has no clean privilege-free service equivalent (a real Windows
 * Service needs elevation and runs outside the user's own profile) --
 * self-heal is its only restart-survival story, so this returns
 * `"unsupported"` there rather than building a weaker third mechanism. */
export async function installDaemonService(): Promise<ServiceInstallResult> {
  writeDaemonLaunchMarker();
  const marker: DaemonLaunchMarker = { node: process.execPath, script: daemonMainPath() };

  switch (process.platform) {
    case "darwin":
      return installLaunchAgent(marker);
    case "linux":
      return installSystemdUnit(marker);
    default:
      return "unsupported";
  }
}
