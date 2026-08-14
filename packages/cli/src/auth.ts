/**
 * Shared server-URL resolution and PAT lookup (§17.10 hardening), used by
 * `init`/`login`/`admin`/`project`. No password prompting anymore -- PATs
 * are generated client-side via `twing keygen`/`twing admin bootstrap`,
 * never typed in, so there's nothing left to prompt for.
 */

import { readConfig, getServerAuth, normalizeServerUrl, findRepoRoot, loadManifestFromFile, twingConfigPath } from "@twing/core";

/**
 * Resolves the coordinator server URL with the precedence shared across
 * init/login/admin/project: explicit flag > `TWING_SERVER` > the current
 * repo's committed `.twing/twing.yml` (if `cwd` happens to be inside one).
 * Deliberately no fallback to "whatever was last cached globally" --
 * with multiple servers cached at once, guessing isn't meaningful.
 */
export function resolveServerUrl(cwd: string, explicit?: string): string | undefined {
  const given = explicit ?? process.env.TWING_SERVER;
  if (given) return normalizeServerUrl(given);
  const repoRoot = findRepoRoot(cwd);
  const fromManifest = loadManifestFromFile(twingConfigPath(repoRoot)).coordinator.serverUrl;
  return fromManifest ? normalizeServerUrl(fromManifest) : undefined;
}

/** Returns the cached PAT for `serverUrl`, or throws with a clear "how to
 * get one" message -- there's no password to fall back to prompting for. */
export function requireAuth(serverUrl: string, label: string): string {
  const token = getServerAuth(readConfig(), serverUrl)?.authToken;
  if (!token) {
    throw new Error(
      `${label}: no personal access token cached for ${serverUrl} -- get an invite code from your project or org ` +
        "admin and run `twing init --invite <code>` (or `twing keygen --invite <code>`), or run " +
        "`twing admin bootstrap` if you're meant to be this server's first admin.",
    );
  }
  return token;
}
