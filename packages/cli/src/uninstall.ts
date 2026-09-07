/**
 * `twing uninstall` -- undoes what `twing init` set up on *this machine*.
 *
 * `npm uninstall -g @twing/cli` on its own leaves the machine in a worse
 * state than either installed or clean: the package goes away, but the
 * daemon keeps running, `~/.claude/settings.json` keeps pointing Claude
 * Code at a `twing-hook` binary that may no longer exist, and (on machines
 * set up before the OS-level service was removed) launchd/systemd keeps
 * respawning the daemon. This command is the step to run *before* the npm
 * uninstall.
 *
 * Order matters and is deliberate: stop the service first so nothing
 * respawns the daemon mid-teardown, then stop the daemon, then unwire the
 * hooks, then delete `~/.twing`. Doing it the other way round can leave a
 * respawned daemon holding a socket inside a directory that has just been
 * removed.
 *
 * What it deliberately does **not** touch: any repo's committed
 * `.claude/settings.json`. That file is shared team state under version
 * control -- removing it is an admin's decision (`twing project
 * disable-enforcement`), not a side effect of one developer cleaning up
 * their own machine. Left in place, it simply bootstraps twing again on the
 * next edit, which is the correct behavior for a repo that still requires
 * it.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defaultSocketPath } from "@twing/core";
import { requestDaemonShutdown, queryDaemonIdentity } from "./daemon-client.js";
import { hookBinaryPath } from "./install-hook.js";
import { unwireHooks } from "./wire-hooks.js";
import { uninstallDaemonService } from "./daemon-service.js";

export interface UninstallOptions {
  /** Report what would be removed without touching anything. */
  dryRun?: boolean;
}

/** Everything `twing uninstall` acts on, so `--dry-run` and the real run
 * describe the same set rather than drifting apart. */
interface Teardown {
  serviceRemoved: boolean;
  daemonStopped: boolean;
  hooksUnwired: boolean;
  twingDirRemoved: boolean;
}

function twingDir(): string {
  return path.join(os.homedir(), ".twing");
}

/** Best-effort stop: ask over the socket, then confirm it actually let go.
 * A daemon that ignores the request is reported rather than force-killed --
 * `twing daemon restart`'s escalation path exists for that, and silently
 * SIGKILLing during an uninstall could drop claims that were still in
 * flight. */
async function stopDaemon(): Promise<boolean> {
  const identity = await queryDaemonIdentity();
  if (!identity) return false; // nothing listening -- already stopped
  await requestDaemonShutdown();
  for (let i = 0; i < 8; i++) {
    if (!(await queryDaemonIdentity())) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

export async function runUninstall(options: UninstallOptions = {}): Promise<void> {
  const hookPath = hookBinaryPath();
  const dir = twingDir();

  if (options.dryRun) {
    console.log("twing uninstall --dry-run: would remove");
    console.log(`  - any launchd/systemd definition for the twing daemon`);
    console.log(`  - the running daemon (socket ${defaultSocketPath()})`);
    console.log(`  - twing's hook entries in ~/.claude/settings.json (${hookPath})`);
    console.log(`  - ${dir} (hook binary, cached tokens, gate overrides, captured sessions)`);
    console.log("twing uninstall --dry-run: would NOT touch any repo's committed .claude/settings.json");
    return;
  }

  const result: Teardown = { serviceRemoved: false, daemonStopped: false, hooksUnwired: false, twingDirRemoved: false };

  // First: a live service would just start the daemon again below.
  result.serviceRemoved = uninstallDaemonService() === "removed";
  if (result.serviceRemoved) console.log("twing uninstall: removed the OS-level daemon service left by an older init");

  result.daemonStopped = await stopDaemon();
  console.log(
    result.daemonStopped
      ? "twing uninstall: stopped the daemon"
      : "twing uninstall: no running daemon to stop",
  );

  result.hooksUnwired = unwireHooks(hookPath);
  console.log(
    result.hooksUnwired
      ? "twing uninstall: removed twing's hook entries from ~/.claude/settings.json"
      : "twing uninstall: no twing hook entries in ~/.claude/settings.json",
  );

  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      result.twingDirRemoved = true;
      console.log(`twing uninstall: removed ${dir}`);
    }
  } catch (err) {
    // Everything above already succeeded; a stubborn directory is worth
    // reporting but not worth failing the whole teardown over.
    console.log(`twing uninstall: couldn't remove ${dir} (${err instanceof Error ? err.message : err}) -- delete it by hand`);
  }

  console.log("twing uninstall: done -- `npm uninstall -g @twing/cli` removes the CLI itself");
  console.log(
    "twing uninstall: repos that commit a twing bootstrap hook will set twing up again on the next edit; " +
      "that's a per-repo admin setting (`twing project disable-enforcement`), deliberately not changed here",
  );
}
