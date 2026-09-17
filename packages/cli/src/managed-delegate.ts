/**
 * Hands a command run from an unmanaged copy of twing to the managed one.
 *
 * The one-step install leaves a copy outside `~/.twing` -- an npm global, most
 * often -- while the coordinator-pinned copy lands in `~/.twing/lib` and is
 * what version recovery keeps current. Typing `twing` still reaches the
 * outside copy first on PATH, which would drift from the coordinator's version
 * silently: the CLI sends no version header. So once the machine is
 * auto-managed and the managed copy exists, the outside copy runs nothing
 * itself and re-executes the same command there.
 *
 * Never delegates from a twing-cli checkout (a contributor runs their own
 * build on purpose) or from npx (`npx @twing/cli@latest ...` asks for that
 * version explicitly).
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const DELEGATED_ENV = "TWING_MANAGED_DELEGATE";

function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function isMonorepoCheckout(entry: string): boolean {
  // dist/index.js -> packages/cli -> packages -> repo root
  try {
    const root = JSON.parse(fs.readFileSync(path.resolve(path.dirname(entry), "..", "..", "..", "package.json"), "utf8"));
    return root.name === "twing-cli" && root.private === true && Array.isArray(root.workspaces);
  } catch {
    return false;
  }
}

export interface DelegateContext {
  home?: string;
  /** The running CLI entry point. */
  entry?: string;
  env?: NodeJS.ProcessEnv;
}

/** The managed entry point to hand off to, or undefined to run here. */
export function managedDelegateTarget(context: DelegateContext = {}): string | undefined {
  const home = context.home ?? os.homedir();
  const entry = realpath(context.entry ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js"));
  const env = context.env ?? process.env;

  if (env[DELEGATED_ENV]) return undefined;
  if (!fs.existsSync(path.join(home, ".twing", "auto-managed"))) return undefined;

  const lib = realpath(path.join(home, ".twing", "lib"));
  const target = path.join(home, ".twing", "lib", "node_modules", "@twing", "cli", "dist", "index.js");
  if (!fs.existsSync(target)) return undefined;
  if (entry.startsWith(lib + path.sep)) return undefined;
  if (entry.includes(`${path.sep}_npx${path.sep}`)) return undefined;
  if (isMonorepoCheckout(entry)) return undefined;
  return target;
}

/** Exits with the managed copy's status when it handed off; returns otherwise. */
export function delegateToManagedInstall(): void {
  const target = managedDelegateTarget();
  if (!target) {
    // Scoped to the one hand-off: a twing started later by this process (a
    // daemon, a shell an agent opens) decides for itself.
    delete process.env[DELEGATED_ENV];
    return;
  }
  const result = spawnSync(process.execPath, [target, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, [DELEGATED_ENV]: "1" },
  });
  // Could not start the managed copy at all: running here beats failing.
  if (result.error) return;
  process.exit(result.status ?? 1);
}
