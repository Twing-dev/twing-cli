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
import { isCodexHooksWired, reportCodexTrust, wireCodexHooks } from "./codex-hooks.js";

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
  /** Codex's `config.toml` or the launcher script changed. False on a
   * machine with no Codex on it, which is left alone entirely. */
  codex: boolean;
}

export function wireMachine(): MachineWiring {
  // Replace any binary-path entries an earlier `twing init` left -- beside the
  // resolver they would fire both for every tool call.
  unwireHooks(hookBinaryPath());
  const claude = writeResolverWiring(globalSettingsPath());
  const openCode = wireOpenCodePlugin();
  const codex = wireCodexHooks().changed;
  return { claude, openCode, codex };
}

/** The one-step install's setup: `postinstall.cjs` calls this.
 *
 * Async only because of Codex's trust step, which asks Codex itself for the
 * hashes of the entries just written (`trustCodexHooks`). Everything else
 * here is a synchronous file write, and the trust step is best-effort: a
 * machine with no Codex, or one whose Codex predates hooks, gets an
 * unavailable verdict and nothing is written. */
export async function runMachineSetup(): Promise<void> {
  const wiring = wireMachine();
  markAutoManaged();

  const harnesses = ["Claude Code", "OpenCode", ...(wiring.codex || isCodexHooksWired() ? ["Codex"] : [])];
  console.log(
    wiring.claude || wiring.openCode || wiring.codex
      ? `twing setup: wired twing into ${listHarnesses(harnesses)} for every directory on this machine. It installs ` +
          "itself the first time a session opens a repo that uses twing, at the version that repo's coordinator asks for."
      : "twing setup: already wired; nothing to change.",
  );

  if (wiring.codex || isCodexHooksWired()) await reportCodexTrust();
}

function listHarnesses(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
