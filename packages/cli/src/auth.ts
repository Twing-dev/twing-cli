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
 * get one" message -- there's no password to fall back to prompting for.
 *
 * §17 Phase 4 carve-out: a server cached with `noAuth: true` (via `twing
 * init --server <url> --no-auth`) never issues PATs at all, so this
 * returns `undefined` instead of throwing -- every call site already
 * passes its result straight into `authFetch`'s optional `token` param,
 * which already tolerates a falsy value with zero signature change. */
export function requireAuth(serverUrl: string, label: string): string | undefined {
  const auth = getServerAuth(readConfig(), serverUrl);
  if (auth?.noAuth) return undefined;
  if (!auth?.authToken) {
    throw new Error(
      `${label}: no personal access token cached for ${serverUrl} -- if this repo is GitHub-hosted, run ` +
        "`twing init` again from a real GitHub login shell (it tries GitHub-verified join/founding by default); " +
        "otherwise get an invite code from your project or org admin and run `twing init --invite <code>` " +
        "(or `twing keygen --invite <code>`), or run `twing admin bootstrap` if you're meant to be this server's first admin.",
    );
  }
  return auth.authToken;
}

/** §17 Phase 3 GitHub-founding: before ever writing a freshly-given server
 * URL into a repo's committed `.twing/twing.yml` (whether from `--server`,
 * `TWING_SERVER`, or `init`'s interactive prompt when neither was given),
 * confirm it's actually a reachable twing coordinator -- a typo landing in
 * that file silently breaks it for every teammate who inherits it. Reuses
 * the trivial unauthenticated root route (`app.get("/", ...)`) rather than
 * adding a dedicated health-check endpoint. */
export async function isReachableCoordinator(serverUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${serverUrl}/`);
    return res.ok && (await res.text()) === "twing serve";
  } catch {
    return false;
  }
}
