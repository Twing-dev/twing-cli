/**
 * `twing init --ghuser` -- the one command a developer runs, ever.
 *
 * The committed hook only fires when Claude Code is started exactly at a repo
 * root, because that is the only place a project's `.claude/settings.json` is
 * read from. Start in a subdirectory or a parent and twing is simply absent:
 * edits ungated, nothing captured, no daemon revived, and no signal to the
 * admin who committed the hook. Nothing inside a repo can fix that, since
 * settings discovery happens before any hook runs.
 *
 * So: two commands, once per machine, run by a human at a terminal.
 *
 *     gh auth login
 *     npx --yes @twing/cli@latest init --ghuser
 *
 * Naming commands here doesn't contradict "developers never run twing
 * commands" -- that rule is about interrupting an agent mid-edit with
 * operational chores, not about a setup step someone deliberately chooses.
 *
 * **Why `npx` and not `npm install -g`.** A global install makes
 * `managedInstall()` false, which deliberately opts the machine *out* of
 * version recovery -- so installing twing to get better coverage would buy
 * worse version handling. Running through npx leaves no global install, and
 * the machine stays managed and self-updating.
 *
 * **This installs nothing.** No CLI, no daemon, no hook binary. The
 * coordinator decides which version to install, and no coordinator is known
 * until a session opens a repo -- so the install waits for that moment (see
 * resolve-hook.ts). A machine that never opens a twing repo downloads
 * nothing at all.
 *
 * Shares only the *name* with `init`: `runInit` resolves a coordinator
 * immediately and prompts or throws without one, so this path short-circuits
 * before any of that. It is machine-scoped where `init` is repo-scoped.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { githubTokenFromGhCli } from "./join.js";
import { globalSettingsPath } from "./wire-hooks.js";
import { wireMachine, markAutoManaged } from "./machine-setup.js";

export { autoManagedMarkerPath } from "./machine-setup.js";

function npmGlobalPrefix(): string | undefined {
  try {
    return execFileSync("npm", ["prefix", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Whether this process is running from the global install it is about to
 * remove.
 *
 * `npm install -g @twing/cli` followed by `twing init --ghuser` would
 * otherwise delete the code currently executing. It survives on Linux through
 * the open inode, which is luck rather than design, and is not something to
 * rely on. Through `npx` the running copy lives in the npx cache, so this is
 * false and the uninstall proceeds normally.
 */
function runningFromGlobalInstall(prefix: string | undefined): boolean {
  if (!prefix) return false;
  try {
    const self = fs.realpathSync(path.dirname(fileURLToPath(import.meta.url)));
    return self.startsWith(fs.realpathSync(prefix));
  } catch {
    return false;
  }
}

/** The command a human can run to finish the job, correct for *this* machine
 * -- `sudo` only where the prefix genuinely needs it, since naming a command
 * that cannot run is worse than naming none. */
function cleanupCommand(prefix: string | undefined): string {
  let needsSudo = false;
  try {
    if (prefix) fs.accessSync(path.join(prefix, "lib", "node_modules"), fs.constants.W_OK);
  } catch {
    needsSudo = true;
  }
  return `${needsSudo ? "sudo " : ""}npm uninstall -g @twing/cli`;
}

export interface GhUserOptions {
  /** Injected by tests; defaults to the real `gh auth token` lookup. */
  githubToken?: () => string | undefined;
  /** Injected by tests. Returns true if the global install is gone afterwards. */
  uninstallGlobal?: () => boolean;
}

/**
 * Returns true when the machine ends up resolver-wired. Throws only when
 * there is no GitHub credential, which is the one thing that cannot be worked
 * around here.
 */
export function runGhUser(options: GhUserOptions = {}): boolean {
  const token = (options.githubToken ?? githubTokenFromGhCli)();
  if (!token) {
    throw new Error(
      "twing init --ghuser: no GitHub credential. Run `gh auth login` first -- twing signs itself in with " +
        "that token, so there is nothing for this command to do without it.",
    );
  }

  const prefix = npmGlobalPrefix();
  const selfIsGlobal = runningFromGlobalInstall(prefix);
  let globalSurvived = false;

  if (selfIsGlobal) {
    // Deleting the code that is running is not something to do on purpose.
    globalSurvived = true;
    console.log("twing init --ghuser: running from the global install, so leaving it in place for now.");
  } else {
    globalSurvived = !(options.uninstallGlobal ?? uninstallGlobalTwing)();
  }

  // The same wiring the one-step install writes (machine-setup.ts), so the two
  // can't drift: resolver entries replacing any binary-path ones, and OpenCode.
  const settings = globalSettingsPath();
  const wiring = wireMachine();
  const changed = wiring.claude || wiring.openCode;

  if (globalSurvived) {
    markAutoManaged();
    console.log(
      `twing init --ghuser: a global @twing/cli is still installed. twing no longer uses it -- but typing ` +
        `\`twing\` yourself will still run that copy, and it won't track the coordinator's version. Clean it ` +
        `up with:\n\n    ${cleanupCommand(prefix)}\n`,
    );
  }

  console.log(
    changed
      ? `twing init --ghuser: wired twing into ${settings}. It now works from any directory, and installs ` +
          "itself the first time a session opens a repo that uses twing -- at whatever version that repo's " +
          "coordinator asks for."
      : `twing init --ghuser: already wired in ${settings}; nothing to change.`,
  );
  return true;
}

/** Returns true if the global install is gone afterwards. Never throws -- a
 * prefix that needs root simply keeps its copy, and the caller reports it. */
function uninstallGlobalTwing(): boolean {
  try {
    execFileSync("npm", ["uninstall", "-g", "@twing/cli", "--loglevel=error"], { stdio: ["ignore", "ignore", "ignore"] });
  } catch {
    // Needs sudo, or npm isn't here. Either way the copy is still there.
  }
  try {
    execFileSync("npm", ["ls", "-g", "@twing/cli", "--depth=0"], { stdio: ["ignore", "ignore", "ignore"] });
    return false; // still listed
  } catch {
    return true; // not installed globally any more
  }
}
