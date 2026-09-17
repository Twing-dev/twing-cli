/**
 * `twing uninstall` -- undoes what npm package installation (or a later
 * `twing init` convergence run) set up on *this machine*.
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
 *
 * Nor `~/.twing/serve-data`. That is a *coordination server's* database --
 * designs, identities, PATs, projects and capture blobs belonging to
 * everyone who points at it -- and this is a client-side command. It only
 * sits under `~/.twing` at all because `db/client.ts` defaults there when
 * `TWING_SERVE_DATA_DIR` is unset, which is the local-development and
 * native-`deploy/` case (the Docker deployment bind-mounts `/data` and was
 * never exposed). Deleting a server's state while uninstalling a client is
 * not this command's decision to make, so there is deliberately no flag for
 * it either: removing a coordinator's data means removing that directory by
 * hand, knowingly.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defaultSocketPath } from "@twing/core";
import { requestDaemonShutdown, queryDaemonIdentity } from "./daemon-client.js";
import { hookBinaryPath } from "./install-hook.js";
import { unwireHooks, globalSettingsPath } from "./wire-hooks.js";
import { removeResolverWiring } from "./resolve-hook.js";
import { unwireOpenCodePlugin } from "./opencode-plugin.js";
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

/** A coordination server's own state, which a client uninstall never removes.
 * See this module's header comment for why it is under `~/.twing` at all. */
const SERVER_DATA_DIR = "serve-data";

/**
 * Removes `~/.twing`, except any server data dir inside it.
 *
 * Returns what happened, because the two outcomes need different words: a
 * machine that never ran `twing serve` gets the directory deleted outright,
 * and one that did keeps it and has to be told, or the next `twing serve`
 * silently resurrects an "uninstalled" coordinator's entire history and
 * nobody knows why.
 *
 * `rmSync` per entry rather than one call on the parent: there is no
 * exclusion option, and the alternative -- move the data aside, delete, move
 * it back -- puts a window in the middle where a crash loses the database,
 * which is the exact outcome this exists to prevent.
 */
function removeTwingDir(dir: string): "removed" | "kept-server-data" | "absent" {
  if (!fs.existsSync(dir)) return "absent";
  let keptServerData = false;
  for (const entry of fs.readdirSync(dir)) {
    if (entry === SERVER_DATA_DIR) {
      keptServerData = true;
      continue;
    }
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
  if (keptServerData) return "kept-server-data";
  fs.rmSync(dir, { recursive: true, force: true });
  return "removed";
}

/**
 * Names any `twing` still runnable after the teardown above.
 *
 * This command can only remove what twing owns (`~/.twing`). A CLI
 * installed by npm lives in npm's prefix, and there can be more than one --
 * a user-level prefix and a root-owned `/usr` one from a `sudo npm install
 * -g` are different installations, and a plain `npm uninstall -g` only
 * touches the former. Someone who has just run both commands and still sees
 * `which twing` answer has no way to tell that from a failed uninstall.
 *
 * Worse, the survivor is often an *older* copy that was shadowed until now,
 * which then fails the coordinator's version check on every gated edit. So
 * say exactly what is left and where.
 */
function reportRemainingCli(): void {
  let remaining: string;
  try {
    remaining = execFileSync("sh", ["-c", "command -v twing"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return; // nothing left on PATH -- the clean case, no need to say anything
  }
  if (!remaining) return;

  console.log(`twing uninstall: note -- \`twing\` still resolves to ${remaining}`);
  console.log(
    "twing uninstall: that is a separate npm-installed copy, not twing's own state. " +
      "`npm uninstall -g @twing/cli` removes it if it is in your own npm prefix; " +
      "one installed with sudo needs `sudo npm uninstall -g @twing/cli`. " +
      "Check every copy with `which -a twing`.",
  );
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
    console.log(`  - twing's Claude hooks and global OpenCode plugin (${hookPath})`);
    console.log(`  - ${dir} (hook binary, the ~/.twing/lib CLI install, cached tokens, gate overrides, captured sessions)`);
    console.log("twing uninstall --dry-run: would NOT touch any repo's committed .claude/settings.json");
    if (fs.existsSync(path.join(dir, SERVER_DATA_DIR))) {
      console.log(
        `twing uninstall --dry-run: would NOT touch ${path.join(dir, SERVER_DATA_DIR)} -- ` +
          "a twing server's database is not a client uninstall's to delete",
      );
    }
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

  // Both wirings: the binary-path entries `twing init` writes, and the
  // resolver entries `--ghuser` writes. Leaving the resolver behind would
  // point Claude Code at a script this command is about to delete -- harmless
  // thanks to its existence guard, but it would also keep reinstalling twing
  // on the next session in any repo that uses it, which is the same way an
  // earlier uninstall defeated itself while reporting success.
  result.hooksUnwired = unwireHooks(hookPath);
  result.hooksUnwired = removeResolverWiring(globalSettingsPath()) || result.hooksUnwired;
  result.hooksUnwired = unwireOpenCodePlugin() || result.hooksUnwired;
  console.log(
    result.hooksUnwired
      ? "twing uninstall: removed twing's global Claude/OpenCode integrations"
      : "twing uninstall: no twing hook entries or OpenCode plugin found",
  );

  try {
    const outcome = removeTwingDir(dir);
    result.twingDirRemoved = outcome !== "absent";
    if (outcome === "removed") {
      console.log(`twing uninstall: removed ${dir}`);
    } else if (outcome === "kept-server-data") {
      console.log(`twing uninstall: removed ${dir}, except ${path.join(dir, SERVER_DATA_DIR)}`);
      console.log(
        "twing uninstall: that directory is a twing *server*'s database -- designs, identities and tokens for " +
          "everyone pointing at it. Uninstalling a client doesn't get to delete it; remove it by hand if you mean to.",
      );
    }
  } catch (err) {
    // Everything above already succeeded; a stubborn directory is worth
    // reporting but not worth failing the whole teardown over.
    console.log(`twing uninstall: couldn't remove ${dir} (${err instanceof Error ? err.message : err}) -- delete it by hand`);
  }

  reportRemainingCli();

  console.log("twing uninstall: done -- `npm uninstall -g @twing/cli` removes the CLI itself");
  console.log(
    "twing uninstall: repos that commit a twing bootstrap hook will set twing up again on the next edit; " +
      "that's a per-repo admin setting (`twing project disable-enforcement`), deliberately not changed here",
  );
}
