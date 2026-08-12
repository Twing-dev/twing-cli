/**
 * Shared password-login flow (§17.10), used by both `init` and `login` --
 * extracted so re-authenticating against a server doesn't require
 * re-running everything else `init` does (hook install, settings wiring,
 * daemon start, constraint seed).
 */

import { readConfig, writeConfig, getServerAuth, setServerAuth, normalizeServerUrl } from "@twing/core";
import { promptPassword } from "./prompt-password.js";

/**
 * §17.10: prompts for a password exactly once per server, then never again
 * for that server -- the result is cached in `~/.twing/config.json`, keyed
 * by `serverUrl` (multi-server: a token cached for one server never applies
 * to another). Skips prompting entirely when the server has no password
 * configured (`{required: false}`), or when a token is already cached for
 * this exact `serverUrl`. A server that's unreachable isn't fatal --
 * proceeds with whatever token (or lack of one) was already held, matching
 * this command's general "config first, connectivity best-effort" posture
 * elsewhere (`init.ts`'s `seedConstraints`).
 *
 * Persists the resulting token itself before returning -- callers don't
 * need a separate `writeConfig` call.
 */
export async function ensureAuthenticated(serverUrl: string, label: string): Promise<string | undefined> {
  const normalized = normalizeServerUrl(serverUrl);
  const existing = getServerAuth(readConfig(), normalized)?.authToken;

  let status: { required?: boolean };
  try {
    const res = await fetch(`${normalized}/v1/auth/status`);
    status = (await res.json()) as { required?: boolean };
  } catch (err) {
    console.log(`${label}: could not reach ${normalized} to check auth status (${err instanceof Error ? err.message : err}) -- continuing without authenticating`);
    return existing;
  }

  if (!status.required) {
    return undefined;
  }
  if (existing) {
    console.log(`${label}: already authenticated with this server`);
    return existing;
  }

  const token = await login(normalized, label);
  writeConfig(setServerAuth(readConfig(), normalized, { authToken: token }));
  return token;
}

async function login(serverUrl: string, label: string): Promise<string> {
  // Non-interactive escape hatch (scripting/CI, or any environment without
  // a real TTY to prompt on) -- promptPassword requires raw-mode stdin and
  // deliberately refuses to run without one.
  if (process.env.TWING_PASSWORD) {
    const res = await fetch(`${serverUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: process.env.TWING_PASSWORD }),
    });
    if (res.ok) {
      const body = (await res.json()) as { token?: string };
      if (body.token) {
        console.log(`${label}: authenticated (via TWING_PASSWORD)`);
        return body.token;
      }
    }
    throw new Error(`${label}: TWING_PASSWORD was rejected by ${serverUrl}`);
  }

  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const password = await promptPassword(`${label}: password for ${serverUrl}: `);
    const res = await fetch(`${serverUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      const body = (await res.json()) as { token?: string };
      if (body.token) {
        console.log(`${label}: authenticated`);
        return body.token;
      }
    }
    console.log(attempt < MAX_ATTEMPTS ? `${label}: incorrect password -- try again` : `${label}: incorrect password`);
  }
  throw new Error(`${label}: failed to authenticate with ${serverUrl} after ${MAX_ATTEMPTS} attempts`);
}
