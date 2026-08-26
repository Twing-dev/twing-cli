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
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultSocketPath } from "@twing/core";

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

function probeSocketOnce(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createConnection(socketPath);
    probe.once("connect", () => {
      probe.end();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls the real socket (ground truth, not `launchctl print`'s own
 * bookkeeping -- the exact thing that was found stale/unreliable) for up to
 * ~2s after a bootout+bootstrap. `RunAtLoad` means a healthy bootstrap
 * should be listening within a few hundred ms; this budget is generous
 * without making a routine `twing init` feel slow on the failure path
 * (which is rare by construction -- see the rollback this guards below). */
export async function waitForDaemonUp(socketPath: string): Promise<boolean> {
  for (let i = 0; i < 8; i++) {
    if (await probeSocketOnce(socketPath)) return true;
    await sleep(250);
  }
  return false;
}

/** macOS: a per-user LaunchAgent (never a LaunchDaemon — those run
 * system-wide and need root; a LaunchAgent needs neither elevation nor any
 * account/registration to install). `RunAtLoad` covers "comes back after a
 * reboot," `KeepAlive` covers "comes back after a crash." */
async function installLaunchAgent(marker: DaemonLaunchMarker): Promise<ServiceInstallResult> {
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
    // Skip entirely when the plist is byte-identical to what's already on
    // disk (the common re-run case: `twing init` in a second/third repo,
    // no build/path change since) -- avoids restarting an already-healthy
    // daemon (and losing its in-memory, not-yet-synced claims) for no
    // reason. Anything else -- first install, or a genuine change (a
    // twing-cli upgrade moving daemon/main.js, a different `process.execPath`)
    // -- falls through to the bootout+bootstrap resync below.
    let existing: string | undefined;
    try {
      existing = fs.readFileSync(plistPath, "utf8");
    } catch {
      // Doesn't exist yet -- first install, fall through.
    }
    if (existing === plist) return "installed";

    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, plist);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    const domain = `gui/${uid ?? ""}`;
    // bootout-then-bootstrap, never bootstrap alone (found live, 2026-08-22):
    // a second `bootstrap` call against an already-loaded label fails
    // ("service already loaded") and was being silently swallowed with no
    // resync -- fine when the plist genuinely didn't change, but when two
    // `twing init` runs raced (confirmed: a concurrent run rewrote this file
    // while this session's own work was in flight), launchd's live job
    // tracking was left pointing at a PID `launchctl kickstart -k` could no
    // longer actually reach, even though `launchctl print` still reported it
    // as that PID -- only a manual `kill` + KeepAlive respawn resynced it.
    // `bootout` first (tolerant of "wasn't loaded" on a genuine first
    // install) guarantees the fresh `bootstrap` below always establishes a
    // known-good, correctly-tracked registration instead of trusting
    // `bootstrap`'s own idempotency, which isn't reliable under a race.
    try {
      execFileSync("launchctl", ["bootout", `${domain}/${LAUNCH_AGENT_LABEL}`], { stdio: "ignore" });
    } catch {
      // Wasn't loaded yet -- expected on a genuine first install.
    }
    try {
      execFileSync("launchctl", ["bootstrap", domain, plistPath], { stdio: "ignore" });
    } catch {
      // Tolerate here too -- whether this throws or "succeeds" but the
      // process never actually comes up (found live, same session: a
      // sufficiently-invalid ProgramArguments pair made `bootstrap` itself
      // throw; a merely-wrong-but-executable one let `bootstrap` return
      // clean while the daemon still never bound the socket) is handled
      // identically below -- both must reach the liveness check and
      // rollback, never short-circuit past it into the outer catch.
    }

    // Verify the resync actually worked before trusting it (found live,
    // 2026-08-22, the same day as the bug above: a marker computed under an
    // unintended node/script pair -- e.g. this package invoked directly
    // under a different nvm version than the real global install -- got
    // bootout+bootstrap'd through by this exact code path once the
    // silent-swallow bug was fixed, leaving the daemon fully unregistered
    // *and* stopped -- strictly worse than the bug this was fixing, which
    // at least left the prior, working registration untouched. `bootout`
    // already stopped the old instance by this point, so there's no good
    // outcome except actively confirming the new one came up -- probing the
    // real socket (ground truth, not `launchctl print`'s own bookkeeping,
    // which is exactly what was unreliable here) and rolling back to the
    // previous plist + re-bootstrapping it if the new one never answers.
    // Deliberately outside the try/catch above (see the two comments just
    // above): a thrown `bootstrap` must not skip this.
    const cameUp = await waitForDaemonUp(defaultSocketPath());
    if (!cameUp && existing !== undefined) {
      try {
        fs.writeFileSync(plistPath, existing);
        try {
          execFileSync("launchctl", ["bootout", `${domain}/${LAUNCH_AGENT_LABEL}`], { stdio: "ignore" });
        } catch {
          // Nothing loaded to bail out of -- fine.
        }
        execFileSync("launchctl", ["bootstrap", domain, plistPath], { stdio: "ignore" });
      } catch {
        // Rollback itself failed -- nothing more to try here; the
        // detached-spawn fallback (`ensureDaemonRunning`) and hook
        // self-heal still cover restart-survival either way, same as every
        // other failure mode this function tolerates.
      }
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
async function installSystemdUnit(marker: DaemonLaunchMarker): Promise<ServiceInstallResult> {
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
    // Verify the unit actually holds the socket before reporting success --
    // ground truth over `systemctl`'s own "active" bookkeeping, same
    // reasoning `installLaunchAgent`'s own `waitForDaemonUp` check already
    // uses. Found live, 2026-08-26: with no check here and `init.ts`
    // calling `ensureDaemonRunning` (the plain spawn fallback) *before*
    // this, a daemon already holding the socket via that fallback made
    // every systemd-managed start attempt lose the race and crash-loop
    // forever underneath a silently-reported "installed". `init.ts` now
    // calls this before the spawn fallback specifically so this check is
    // what decides whether a fallback spawn is still needed, not a race
    // between two independently-started daemons.
    const cameUp = await waitForDaemonUp(defaultSocketPath());
    return cameUp ? "installed" : "failed";
  } catch {
    return "failed";
  }
}

/** Which OS-level service (if any) is currently installed for this daemon --
 * `daemon-restart.ts` uses this to decide whether to restart via the
 * service manager directly (launchd/systemd) or fall back to the plain
 * socket-shutdown + spawn path. Checks for the plist/unit file on disk,
 * same ground-truth-over-bookkeeping preference `waitForDaemonUp` already
 * uses for the socket itself. */
export function isServiceInstalled(): "launchd" | "systemd" | "none" {
  if (process.platform === "darwin" && fs.existsSync(launchAgentPlistPath())) return "launchd";
  if (process.platform === "linux" && fs.existsSync(systemdUnitPath())) return "systemd";
  return "none";
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
      return await installSystemdUnit(marker);
    default:
      return "unsupported";
  }
}
