import * as os from "node:os";
import * as path from "node:path";

/** `~/.twing/daemon.sock`, or `$TWING_SOCK` if set (§4) — the single
 * source of truth so the daemon, the CLI, and twing-hook (independently,
 * in Go) all agree on where to find each other. */
export function defaultSocketPath(): string {
  return process.env.TWING_SOCK ?? path.join(os.homedir(), ".twing", "daemon.sock");
}
