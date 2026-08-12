/**
 * `twing login` (§4 of the multi-server plan): the cheap, repeatable
 * subset of `init` -- authenticate against a coordinator and cache the
 * resulting token, without touching hook install, `.claude/settings.json`
 * wiring, the daemon, or constraint seeding. For a second repo pointed at
 * a new coordinator, or a token that's gone stale.
 */

import { findRepoRoot, loadManifestFromFile, twingConfigPath, normalizeServerUrl } from "@twing/core";
import { ensureAuthenticated } from "./auth.js";

export interface LoginOptions {
  server?: string;
  cwd: string;
}

export async function runLogin(options: LoginOptions): Promise<void> {
  const repoRoot = findRepoRoot(options.cwd);
  const manifest = loadManifestFromFile(twingConfigPath(repoRoot));

  // Same precedence as `init`, and the same "no fallback-guessing" rule --
  // `login` needs an explicit target just as much as `init` does.
  const rawServerUrl = options.server ?? process.env.TWING_SERVER ?? manifest.coordinator.serverUrl;
  if (!rawServerUrl) {
    throw new Error(
      "twing login: no server URL given -- pass --server <url>, set TWING_SERVER, or run this from a repo whose " +
        ".twing/twing.yml already declares a coordinator.",
    );
  }
  const serverUrl = normalizeServerUrl(rawServerUrl);
  console.log(`twing login: server = ${serverUrl}`);

  const authToken = await ensureAuthenticated(serverUrl, "twing login");
  console.log(authToken ? "twing login: done" : "twing login: done (this server has no password configured)");
}
