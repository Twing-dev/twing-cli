/**
 * Making the CLI's own `twing ...` hints runnable on the machine reading
 * them.
 *
 * Around twenty messages point the reader at another command -- "run
 * `twing login` to re-authenticate", "run `twing init --server <url>` once
 * to set it up", "they redeem it with `twing keygen --invite <code>`". All
 * of them assume `twing` is on `PATH`, which was true while `npm install
 * -g` was the only way in. It is not true on a machine onboarded by the
 * committed bootstrap hook: that path avoids `-g` on purpose (it needs
 * sudo, and a hook has no TTY to answer a password prompt), so the CLI
 * lives at `~/.twing/bin/twing` with nothing on `PATH` pointing at it.
 *
 * A hint naming a command that does not exist is worse than no hint. It is
 * the same incoherence that, on the Go side, led a real session to conclude
 * the tool was lying to it -- see `withResolvedTwingCLI` in
 * hook/design_gate.go, which fixes the identical problem for deny messages.
 *
 * **Why this cannot simply copy the Go rule.** There, any `twing
 * <subcommand>` is a command. Here it is ambiguous, because this CLI also
 * uses `twing <subcommand>:` as its log prefix:
 *
 *     twing align: no coordinator configured for this repo    <- prefix
 *     run `twing init --server <url>` once to set it up       <- command
 *
 * Porting the Go rule would rewrite the first into
 * `/home/u/.twing/bin/twing align: no coordinator...`, which is nonsense.
 *
 * The discriminator is that commands are wrapped in backticks and prefixes
 * never are -- a convention every hint in this package already follows. So
 * only backticked text is touched, which leaves prefixes alone by
 * construction rather than by a list of exceptions.
 *
 * Nothing here is cached. Every CLI run is a fresh process, so a developer
 * who installs globally mid-session gets bare `twing` back on the very next
 * message, with no invalidation step.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { cliShimPath } from "./install-hook.js";

/** Verbs that make `twing <verb>` an instruction rather than prose. Kept in
 * step with `twingSubcommands` in hook/design_gate.go. `serve` is absent
 * from both: it names the coordination server, never something to run
 * here. */
const TWING_SUBCOMMANDS = [
  "init",
  "login",
  "join",
  "whoami",
  "keygen",
  "design",
  "project",
  "admin",
  "align",
  "daemon",
  "constraints",
  "uninstall",
  "servers",
];

/** How to invoke twing here: the bare name when it actually resolves (what
 * a reader expects to see, and what they would type), otherwise the
 * absolute shim -- which works without touching `PATH` or any shell rc,
 * neither of which could help the process already running. */
export function twingCommandName(): string {
  if (isOnPath("twing")) return "twing";
  const shim = cliShimPath();
  return fs.existsSync(shim) ? shim : "twing";
}

/** Walks `PATH` directly rather than shelling out to `command -v`.
 * Two reasons, both found by a test: a spawn per lookup would run on every
 * single `console.log` once the wrapper below is installed, and
 * `execFileSync("sh", ...)` resolves `sh` through `PATH` too -- so a
 * stripped or unusual `PATH` made detection fail in exactly the situation
 * it needed to work. A handful of `stat` calls has neither problem. */
function isOnPath(name: string): boolean {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK);
      return true;
    } catch {
      // Not here, or not executable -- keep looking.
    }
  }
  return false;
}

/**
 * Rewrites backticked `twing <subcommand> ...` spans in `text` to whatever
 * runs on this machine. Anything outside backticks -- notably this
 * package's `twing <subcommand>:` log prefixes -- is returned untouched.
 */
export function resolveTwingHints(text: string): string {
  const cli = twingCommandName();
  if (cli === "twing") return text;

  return text.replace(/`([^`]*)`/g, (whole, inner: string) => {
    for (const sub of TWING_SUBCOMMANDS) {
      if (inner.startsWith(`twing ${sub}`)) {
        return `\`${cli}${inner.slice("twing".length)}\``;
      }
    }
    return whole;
  });
}

/**
 * Applies `resolveTwingHints` to everything the CLI prints, from one place.
 *
 * A choke point rather than ~20 call-site edits: the hints are spread over
 * eight files, and any message added later would silently miss an explicit
 * call. This mirrors how the Go side solved it -- one substitution where
 * messages are rendered, so the call sites keep writing the readable bare
 * form.
 *
 * Only for the human/agent-facing CLI entrypoint. The daemon has its own
 * entrypoint and writes to a log file, where rewriting would serve nobody.
 */
export function installTwingHintResolution(): void {
  for (const stream of ["log", "error"] as const) {
    const original = console[stream].bind(console);
    console[stream] = (...args: unknown[]) => {
      original(...args.map((arg) => (typeof arg === "string" ? resolveTwingHints(arg) : arg)));
    };
  }
}
