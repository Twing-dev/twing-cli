/**
 * `twing keygen` (§17.10 hardening): generates a personal access token on
 * the developer's own machine -- the server only ever sees its hash, never
 * the plaintext, not even the admin who issued the invite. Reuses an
 * already-cached PAT for this server if one exists (an already-known
 * developer joining a second org/project attaches the new membership to
 * their existing identity rather than minting a second one); otherwise
 * mints a fresh token and redeems the given invite unauthenticated,
 * creating a new developer identity.
 */

import * as crypto from "node:crypto";
import { readConfig, writeConfig, getServerAuth, setServerAuth, normalizeServerUrl, authFetch, computeDeveloperId } from "@twing/core";

export function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export interface KeygenOptions {
  cwd: string;
  serverUrl: string;
  invite: string;
  label?: string;
}

interface RedeemResponseJSON {
  developerId?: string;
  error?: string;
}

/**
 * Redeems an invite against `serverUrl`, persisting the resulting PAT
 * locally before returning -- callers don't need a separate `twing login`
 * afterward.
 */
export async function runKeygen(options: KeygenOptions): Promise<string> {
  const serverUrl = normalizeServerUrl(options.serverUrl);
  const existing = getServerAuth(readConfig(), serverUrl)?.authToken;

  if (existing) {
    const res = await authFetch(`${serverUrl}/v1/invites/${options.invite}/redeem`, { method: "POST" }, existing);
    const body = (await res.json().catch(() => ({}))) as RedeemResponseJSON;
    if (!res.ok || !body.developerId) {
      throw new Error(`twing keygen: invite redemption failed -- ${body.error ?? res.statusText}`);
    }
    console.log(`twing keygen: joined using your existing PAT for this server (${body.developerId})`);
    return existing;
  }

  const token = generateToken();
  const label = options.label ?? computeDeveloperId(options.cwd);
  const res = await authFetch(`${serverUrl}/v1/invites/${options.invite}/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tokenHash: hashToken(token), label }),
  });
  const body = (await res.json().catch(() => ({}))) as RedeemResponseJSON;
  if (!res.ok || !body.developerId) {
    throw new Error(`twing keygen: invite redemption failed -- ${body.error ?? res.statusText}`);
  }

  writeConfig(setServerAuth(readConfig(), serverUrl, { authToken: token }));
  console.log(`twing keygen: generated a new personal access token for ${body.developerId}.`);
  console.log(`twing keygen: ${token}`);
  console.log("twing keygen: this is the only time it will be shown -- it's cached locally in ~/.twing/config.json.");
  return token;
}
