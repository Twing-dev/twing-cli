/**
 * Printing a freshly minted PAT, safely.
 *
 * Three commands mint one (`join`, `keygen`, `admin bootstrap`) and each used
 * to print it unconditionally. That is right in front of a human at a
 * terminal and wrong everywhere else: `init --unattended` is invoked by the
 * committed bootstrap hook and by `twing-resolve` with its output redirected
 * into `~/.twing/bootstrap.log`, so every zero-touch onboarding wrote a live
 * credential into a plaintext file nobody was ever going to read. Found on
 * this machine four times over three days (2026-09-14 through 2026-09-17),
 * once per automatic install, each one needing a manual revoke.
 *
 * Suppressing it loses nothing: the token is cached in `~/.twing/config.json`
 * by the same call, and `twing whoami --show-token` prints it back on
 * request. The one-time print is a convenience, not the only copy.
 */

/**
 * Whether a newly minted token may be written to stdout.
 *
 * Two conditions, and both matter. `unattended` is the honest signal -- the
 * caller knows no human is present. The TTY check is the backstop for
 * everything else that redirects: a `twing join` piped to a file, a CI job, a
 * wrapper script capturing output for a log. Neither is a place to put a
 * credential that the config file already holds.
 */
export function mayPrintNewToken(unattended?: boolean): boolean {
  return !unattended && process.stdout.isTTY === true;
}

/**
 * Announces a newly minted PAT: the token itself only where that is safe,
 * and otherwise where to find it. `command` is the user-facing command name
 * (`"twing join"`), so the lines read as that command's own output.
 */
export function announceNewToken(command: string, token: string, unattended?: boolean): void {
  if (mayPrintNewToken(unattended)) {
    console.log(`${command}: ${token}`);
    console.log(`${command}: this is the only time it will be shown -- it's cached locally in ~/.twing/config.json.`);
    return;
  }
  // Say why, not just less: someone reading a bootstrap log should be able to
  // tell that a token exists and was deliberately kept out of this file,
  // rather than wonder whether onboarding half-failed.
  console.log(
    `${command}: the token is not printed here -- this output is not a terminal, and a credential in a log file ` +
      "is a credential to revoke. It's cached in ~/.twing/config.json; `twing whoami --show-token` prints it.",
  );
}
