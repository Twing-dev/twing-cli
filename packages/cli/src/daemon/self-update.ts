/**
 * Keeping a twing-managed install current, without asking anyone.
 *
 * The version-mismatch deny used to hand the agent
 * `npm install -g @twing/cli@latest && twing init && twing daemon restart`.
 * That is a bad shape twice over: it spends tokens on an operational chore
 * mid-task, and an install instruction arriving as *denied tool output* is
 * indistinguishable from a prompt-injection attempt, so a well-behaved
 * agent refuses it -- observed repeatedly. Anything automatable should not
 * be asked of the agent at all.
 *
 * **The whole sequence, not a shortcut.** It is tempting to just drop a
 * matching `twing-hook` binary in place, since that alone clears the gate's
 * 426. It would also leave a stale daemon running, and version skew there
 * is silent data loss rather than an inconvenience: a 0.2.13 daemon does
 * not know `session_end` or `get_identity` (both added later), and the
 * daemon answers an unrecognised message type with a `console.error` and no
 * reply. So the final transcript drain vanishes at the end of every
 * session, and `twing daemon restart`/`twing uninstall` can no longer
 * identify the process they are managing. Clearing the deny while leaving
 * that in place is the looks-fixed-but-isn't failure this project keeps
 * hitting. Update the CLI, refresh the hook binary and launch marker, and
 * cycle the daemon.
 *
 * **Only a twing-managed install.** `~/.twing/lib` is ours: written by the
 * bootstrap hook, under the developer's own home, no elevation needed. A
 * CLI installed with `npm install -g` lives in npm's prefix and may need
 * root, which a background daemon has no way to obtain and no business
 * assuming -- those machines keep the existing message.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Generous: an npm install over a slow link plus a hook-binary fetch. Still
 * bounded, so a hung network can't leave the update wedged forever. */
const UPDATE_TIMEOUT_MS = 5 * 60 * 1000;

export function twingLibDir(): string {
  return path.join(os.homedir(), ".twing", "lib");
}

function managedCliEntry(): string {
  return path.join(twingLibDir(), "node_modules", "@twing", "cli", "dist", "index.js");
}

function updateLogPath(): string {
  return path.join(os.homedir(), ".twing", "bootstrap.log");
}

/**
 * Whether this daemon is running out of the twing-managed install, and can
 * therefore replace itself.
 *
 * Asks where *this process's own code* lives rather than merely whether
 * `~/.twing/lib` exists: a global install can leave that directory behind,
 * and updating a copy nothing is running from would report success while
 * changing nothing.
 */
export function isSelfUpdatable(moduleUrl: string): boolean {
  try {
    const self = fs.realpathSync(path.dirname(new URL(moduleUrl).pathname));
    return self.startsWith(fs.realpathSync(twingLibDir()));
  } catch {
    return false; // ~/.twing/lib absent -- a global install or a checkout
  }
}

function appendLog(line: string): void {
  try {
    fs.mkdirSync(path.dirname(updateLogPath()), { recursive: true });
    fs.appendFileSync(updateLogPath(), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Logging is best-effort; never let it stop an update.
  }
}

export interface SelfUpdateDeps {
  run(command: string, args: string[]): Promise<void>;
  cliEntry(): string;
  log(line: string): void;
}

const defaultDeps: SelfUpdateDeps = {
  run: async (command, args) => {
    await execFileAsync(command, args, { timeout: UPDATE_TIMEOUT_MS });
  },
  cliEntry: managedCliEntry,
  log: appendLog,
};

/**
 * Installs `targetVersion` over the managed copy and refreshes everything
 * derived from it. Returns whether the update landed; the caller decides
 * what to do about the now-stale process it is running in.
 *
 * Pinned to the coordinator's own version rather than `@latest`: those can
 * differ (a release published but not yet deployed), and chasing `latest`
 * would swap one mismatch for another and re-trigger immediately.
 */
export async function performSelfUpdate(targetVersion: string, deps: SelfUpdateDeps = defaultDeps): Promise<boolean> {
  deps.log(`self-update: coordinator wants ${targetVersion}; updating the managed install`);
  try {
    await deps.run("npm", [
      "install",
      "--prefix",
      twingLibDir(),
      `@twing/cli@${targetVersion}`,
      "--no-fund",
      "--no-audit",
      "--loglevel=error",
    ]);
  } catch (err) {
    deps.log(`self-update: npm install failed -- ${err instanceof Error ? err.message : err}`);
    return false;
  }

  // The *new* CLI does this, not the running one: it refreshes the
  // twing-hook binary (whose stamped version is what the gate actually
  // sends) and rewrites the launch marker, so the daemon that comes back
  // starts from the new code.
  try {
    await deps.run(process.execPath, [deps.cliEntry(), "init", "--unattended"]);
  } catch (err) {
    deps.log(`self-update: the updated CLI's init failed -- ${err instanceof Error ? err.message : err}`);
    return false;
  }

  deps.log(`self-update: updated to ${targetVersion}; restarting the daemon so it stops running the old code`);
  return true;
}
