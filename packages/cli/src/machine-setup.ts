/**
 * Machine wiring shared by the one-step install and `twing init --ghuser`.
 *
 * Both leave a machine in the same state: the resolver wired into
 * `~/.claude/settings.json`, the OpenCode plugin installed, and nothing
 * installed into `~/.twing/lib`. The coordinator picks the version, so the CLI,
 * hook binary and daemon arrive lazily the first time a session opens a repo
 * that uses twing -- and version recovery keeps them current from then on.
 * One function so the two entry points cannot drift apart.
 *
 * The one-step install (npm global postinstall, or `install.sh`) differs from
 * `--ghuser` only in needing no GitHub credential, and in always leaving a copy
 * outside `~/.twing` -- hence the `auto-managed` marker, which keeps the
 * managed copy authoritative (`managed-delegate.ts`).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { hookBinaryPath } from "./install-hook.js";
import { unwireHooks, globalSettingsPath } from "./wire-hooks.js";
import { writeResolverWiring } from "./resolve-hook.js";
import { wireOpenCodePlugin } from "./opencode-plugin.js";

/**
 * Set when a copy of twing outside `~/.twing` survives, and read by
 * everything that decides which copy is authoritative.
 *
 * Without it, a `twing` on PATH makes `managedInstall()` false and the machine
 * stops auto-updating. With it, `~/.twing/lib` drives the hook, the daemon and
 * both recovery paths, and the other copy hands off to it.
 */
export function autoManagedMarkerPath(): string {
  return path.join(os.homedir(), ".twing", "auto-managed");
}

export function markAutoManaged(): void {
  fs.mkdirSync(path.dirname(autoManagedMarkerPath()), { recursive: true });
  if (!fs.existsSync(autoManagedMarkerPath())) {
    fs.writeFileSync(autoManagedMarkerPath(), `${new Date().toISOString()}\n`);
  }
}

export interface MachineWiring {
  /** `~/.claude/settings.json` or the resolver script changed. */
  claude: boolean;
  /** The OpenCode loader or adapter changed. */
  openCode: boolean;
}

export function wireMachine(): MachineWiring {
  // Replace any binary-path entries an earlier `twing init` left -- beside the
  // resolver they would fire both for every tool call.
  unwireHooks(hookBinaryPath());
  const claude = writeResolverWiring(globalSettingsPath());
  const openCode = wireOpenCodePlugin();
  return { claude, openCode };
}

/** The one-step install's setup: `postinstall.cjs` calls this. */
export function runMachineSetup(): void {
  const wiring = wireMachine();
  markAutoManaged();
  console.log(
    wiring.claude || wiring.openCode
      ? "twing setup: wired twing into Claude Code and OpenCode for every directory on this machine. It installs " +
          "itself the first time a session opens a repo that uses twing, at the version that repo's coordinator asks for."
      : "twing setup: already wired; nothing to change.",
  );
}
