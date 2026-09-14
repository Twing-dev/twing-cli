/**
 * Repository-independent machine setup invoked by the npm postinstall.
 *
 * Repository enrollment and identity recovery happen lazily from the
 * target file's `.twing/twing.yml`; this command only installs the shared
 * runtime and agent-global entry points. It can therefore run from $HOME,
 * a parent workspace, or any unrelated directory.
 */

import { ensureHookInstalled, ensureCliShim } from "./install-hook.js";
import { wireHooks } from "./wire-hooks.js";
import { ensureDaemonRunning } from "./spawn-daemon.js";

export interface MachineSetupDeps {
  ensureHookInstalled: () => Promise<string>;
  ensureCliShim: () => string | null;
  wireHooks: (hookPath: string) => boolean;
  ensureDaemonRunning: () => Promise<"already-running" | "started" | "failed">;
}

const defaultDeps: MachineSetupDeps = { ensureHookInstalled, ensureCliShim, wireHooks, ensureDaemonRunning };

export async function runMachineSetup(deps: MachineSetupDeps = defaultDeps): Promise<void> {
  const hookPath = await deps.ensureHookInstalled();
  console.log(`twing setup: shared hook installed at ${hookPath}`);

  deps.ensureCliShim();
  const changed = deps.wireHooks(hookPath);
  console.log(changed
    ? "twing setup: wired Claude and OpenCode globally"
    : "twing setup: Claude and OpenCode integrations already wired globally");

  const daemon = await deps.ensureDaemonRunning();
  if (daemon === "failed") {
    console.log("twing setup: daemon failed to start -- see ~/.twing/daemon.log");
  } else {
    console.log(daemon === "started" ? "twing setup: daemon started" : "twing setup: daemon already running");
  }

  console.log("twing setup: done -- repositories with .twing/twing.yml are discovered automatically; no per-repo init is needed");
}
