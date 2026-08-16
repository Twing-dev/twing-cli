/**
 * `twing login` (§17.10 hardening): caches an already-generated personal
 * access token for a server -- PAT-only now, no password prompt. A brand
 * new developer gets their PAT from `twing keygen --invite <code>` (or
 * `twing init --invite <code>`); `login` is for re-caching an existing one
 * on a new machine, or after a stale/expired local config.
 */

import { readConfig, writeConfig, setServerAuth, authFetch } from "@twing/core";
import { resolveServerUrl } from "./auth.js";
import { promptPassword } from "./prompt-password.js";

export interface LoginOptions {
  server?: string;
  token?: string;
  cwd: string;
}

interface WhoamiResponseJSON {
  developerId?: string;
  error?: string;
}

export async function runLogin(options: LoginOptions): Promise<void> {
  const serverUrl = resolveServerUrl(options.cwd, options.server);
  if (!serverUrl) {
    throw new Error(
      "twing login: no server URL given -- pass --server <url>, set TWING_SERVER, or run this from a repo whose " +
        ".twing/twing.yml already declares a coordinator.",
    );
  }
  console.log(`twing login: server = ${serverUrl}`);

  const token = options.token ?? (await promptPassword("twing login: paste your personal access token: "));
  const res = await authFetch(`${serverUrl}/v1/auth/whoami`, {}, token);
  const body = (await res.json().catch(() => ({}))) as WhoamiResponseJSON;
  if (!res.ok || !body.developerId) {
    throw new Error(`twing login: token was rejected by ${serverUrl} (${body.error ?? res.statusText})`);
  }

  writeConfig(setServerAuth(readConfig(), serverUrl, { authToken: token }));
  console.log(`twing login: authenticated as ${body.developerId}`);
}
