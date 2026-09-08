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
 * **Any install this user can write.** A twing-managed `~/.twing/lib` copy
 * is replaced in place; a global install in a user-owned prefix
 * (`~/.npm-global`, nvm, any `npm config set prefix`) is updated with `npm
 * install -g`, which needs no elevation there and keeps the developer's own
 * `twing` on PATH current instead of shadowing it. Only a genuinely
 * root-owned prefix is refused -- a background daemon cannot obtain root,
 * and there the explicit instructions really are the only option.
 */

import { execFile, execFileSync } from "node:child_process";
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

/** The globally-installed CLI's entry point, resolved from npm's own
 * prefix rather than guessed -- a user prefix can be anywhere. */
function globalCliEntry(): string {
  const prefix = execFileSync("npm", ["prefix", "-g"], { encoding: "utf8" }).trim();
  return path.join(prefix, "lib", "node_modules", "@twing", "cli", "dist", "index.js");
}

function updateLogPath(): string {
  return path.join(os.homedir(), ".twing", "bootstrap.log");
}

/**
 * Whether this daemon can replace the install it is running from.
 *
 * Asks whether the install is **writable by this user**, not where it sits.
 * The first version tested location -- "is this code under `~/.twing/lib`"
 * -- using it as a proxy for "can we write it", on the reasoning that a
 * global `npm install -g` may need root. That reasoning is wrong for the
 * common case: `~/.npm-global`, nvm, and any `npm config set prefix` setup
 * put the global install under the user's own home, writable with no sudo
 * at all. Those machines were excluded from self-update for no reason, and
 * kept being told to run three commands by hand. Found live.
 *
 * Testing the actual permission keeps the genuine sudo case (a root-owned
 * `/usr/lib/node_modules`) excluded, where the explicit instructions really
 * are the only option -- and covers everything else.
 *
 * Resolves through symlinks first: an install reached via a symlinked path
 * must be judged on the directory that would actually be written.
 */
export function isSelfUpdatable(moduleUrl: string): boolean {
  try {
    // .../dist/daemon/self-update.js -> the package root that npm replaces.
    const selfDir = fs.realpathSync(path.dirname(new URL(moduleUrl).pathname));
    const packageRoot = path.resolve(selfDir, "..", "..");
    fs.accessSync(packageRoot, fs.constants.W_OK);
    return true;
  } catch {
    return false; // root-owned, missing, or otherwise not ours to replace
  }
}

/** Where an update should install, given where this code is running from.
 * A twing-managed install replaces itself in place; anything else
 * user-writable (a `~/.npm-global`-style prefix) is updated with `npm
 * install -g`, which needs no elevation there and keeps the developer's own
 * `twing` on PATH current rather than shadowing it with a second copy. */
export function updateTarget(moduleUrl: string): "managed" | "global" {
  try {
    const selfDir = fs.realpathSync(path.dirname(new URL(moduleUrl).pathname));
    return selfDir.startsWith(fs.realpathSync(twingLibDir())) ? "managed" : "global";
  } catch {
    return "global";
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
  /** Entry point of the CLI that was just updated -- the one whose `init`
   * must run, so the refreshed hook binary and launch marker come from the
   * new code rather than the old process doing the updating. */
  cliEntry(target: "managed" | "global"): string;
  log(line: string): void;
}

const defaultDeps: SelfUpdateDeps = {
  run: async (command, args) => {
    await execFileAsync(command, args, { timeout: UPDATE_TIMEOUT_MS });
  },
  cliEntry: (target) => (target === "managed" ? managedCliEntry() : globalCliEntry()),
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
export async function performSelfUpdate(
  targetVersion: string,
  target: "managed" | "global" = "managed",
  deps: SelfUpdateDeps = defaultDeps,
): Promise<boolean> {
  deps.log(`self-update: coordinator wants ${targetVersion}; updating the ${target} install`);
  // `--prefix ~/.twing/lib` for the copy twing itself installed; `-g` for a
  // global one, so the update lands where `twing` on PATH actually resolves
  // rather than beside it. Both are unprivileged here -- isSelfUpdatable
  // has already confirmed this user can write the target.
  const installArgs =
    target === "managed"
      ? ["install", "--prefix", twingLibDir(), `@twing/cli@${targetVersion}`]
      : ["install", "-g", `@twing/cli@${targetVersion}`];
  try {
    await deps.run("npm", [...installArgs, "--no-fund", "--no-audit", "--loglevel=error"]);
  } catch (err) {
    deps.log(`self-update: npm install failed -- ${err instanceof Error ? err.message : err}`);
    return false;
  }

  // The *new* CLI does this, not the running one: it refreshes the
  // twing-hook binary (whose stamped version is what the gate actually
  // sends) and rewrites the launch marker, so the daemon that comes back
  // starts from the new code.
  try {
    await deps.run(process.execPath, [deps.cliEntry(target), "init", "--unattended"]);
  } catch (err) {
    deps.log(`self-update: the updated CLI's init failed -- ${err instanceof Error ? err.message : err}`);
    return false;
  }

  deps.log(`self-update: updated to ${targetVersion}; restarting the daemon so it stops running the old code`);
  return true;
}
