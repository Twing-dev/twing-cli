/**
 * `twing admin *` (§17.10 hardening): org-scoped admin actions --
 * bootstrap the very first identity, invite further developers, list/
 * revoke. Mirrors `design.ts`'s command-per-function style and its local
 * response-DTO-interface convention.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { readConfig, writeConfig, setServerAuth, authFetch, computeDeveloperId } from "@twing/core";
import { resolveServerUrl, requireAuth } from "./auth.js";
import { generateToken, hashToken } from "./keygen.js";

type Role = "admin" | "member";

function readLocalBootstrapToken(): string | undefined {
  const dataDir = process.env.TWING_SERVE_DATA_DIR ?? path.join(os.homedir(), ".twing", "serve-data");
  const file = path.join(dataDir, "bootstrap-token");
  if (!fs.existsSync(file)) return undefined;
  return fs.readFileSync(file, "utf8").trim();
}

export interface AdminBootstrapOptions {
  cwd: string;
  server?: string;
  token?: string;
  label?: string;
  orgName?: string;
}

interface BootstrapResponseJSON {
  developerId?: string;
  orgId?: string;
  error?: string;
}

/** Break-glass: claims the one-time bootstrap token `twing serve` prints
 * on first run, generating this developer's own PAT locally in the same
 * step (§17.10 hardening -- the bootstrap token only authorizes this call,
 * it isn't itself the credential used afterward). */
export async function runAdminBootstrap(options: AdminBootstrapOptions): Promise<void> {
  const serverUrl = resolveServerUrl(options.cwd, options.server);
  if (!serverUrl) throw new Error("twing admin bootstrap: no server URL given -- pass --server <url> or set TWING_SERVER.");

  const bootstrapToken = options.token ?? readLocalBootstrapToken();
  if (!bootstrapToken) {
    throw new Error(
      "twing admin bootstrap: no bootstrap token given -- pass --token <it> (see the server's startup log, or " +
        "`cat ~/.twing/serve-data/bootstrap-token` if you're on the same machine as `twing serve`).",
    );
  }

  const token = generateToken();
  const label = options.label ?? computeDeveloperId(options.cwd);
  const res = await authFetch(`${serverUrl}/v1/admin/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bootstrapToken, tokenHash: hashToken(token), label, orgName: options.orgName }),
  });
  const body = (await res.json().catch(() => ({}))) as BootstrapResponseJSON;
  if (!res.ok || !body.developerId) {
    throw new Error(`twing admin bootstrap: ${body.error ?? res.statusText}`);
  }

  writeConfig(setServerAuth(readConfig(), serverUrl, { authToken: token }));
  console.log(`twing admin bootstrap: created organization ${body.orgId} with you (${body.developerId}) as its admin.`);
  console.log(`twing admin bootstrap: ${token}`);
  console.log("twing admin bootstrap: this is the only time your PAT will be shown -- it's cached locally in ~/.twing/config.json.");
}

export interface AdminInviteOptions {
  cwd: string;
  server?: string;
  label?: string;
  role?: Role;
  orgId?: string;
}

interface InviteResponseJSON {
  code?: string;
  expiresAt?: number;
  error?: string;
}

export async function runAdminInvite(options: AdminInviteOptions): Promise<void> {
  const serverUrl = resolveServerUrl(options.cwd, options.server);
  if (!serverUrl) throw new Error("twing admin invite: no server URL given -- pass --server <url> or set TWING_SERVER.");
  if (!options.label) throw new Error("twing admin invite: --label <email> is required");
  const token = requireAuth(serverUrl, "twing admin invite");

  const res = await authFetch(
    `${serverUrl}/v1/admin/invites`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: options.label, role: options.role, orgId: options.orgId }),
    },
    token,
  );
  const body = (await res.json().catch(() => ({}))) as InviteResponseJSON;
  if (!res.ok || !body.code) throw new Error(`twing admin invite: ${body.error ?? res.statusText}`);
  console.log(`twing admin invite: code = ${body.code}  (expires ${new Date(body.expiresAt ?? 0).toISOString()})`);
  console.log(
    `twing admin invite: hand this to ${options.label} -- they redeem it with \`twing keygen --invite ${body.code}\` ` +
      `(or \`twing init --invite ${body.code}\` from their checkout).`,
  );
}

export interface AdminListInvitesOptions {
  cwd: string;
  server?: string;
  orgId?: string;
}

interface InviteListItem {
  code: string;
  role: string;
  label: string;
  expiresAt: number;
  consumedAt?: number;
}

export async function runAdminListInvites(options: AdminListInvitesOptions): Promise<void> {
  const serverUrl = resolveServerUrl(options.cwd, options.server);
  if (!serverUrl) throw new Error("twing admin list-invites: no server URL given -- pass --server <url> or set TWING_SERVER.");
  const token = requireAuth(serverUrl, "twing admin list-invites");
  const params = options.orgId ? `?orgId=${encodeURIComponent(options.orgId)}` : "";
  const res = await authFetch(`${serverUrl}/v1/admin/invites${params}`, {}, token);
  const body = (await res.json().catch(() => ({}))) as { items?: InviteListItem[]; error?: string };
  if (!res.ok) throw new Error(`twing admin list-invites: ${body.error ?? res.statusText}`);
  for (const i of body.items ?? []) {
    const status = i.consumedAt ? "consumed" : Date.now() > i.expiresAt ? "expired" : "pending";
    console.log(`${i.code}  [${status}]  ${i.label}  role=${i.role}`);
  }
}

export interface AdminRevokeInviteOptions {
  cwd: string;
  server?: string;
  code?: string;
}

export async function runAdminRevokeInvite(options: AdminRevokeInviteOptions): Promise<void> {
  const serverUrl = resolveServerUrl(options.cwd, options.server);
  if (!serverUrl) throw new Error("twing admin revoke-invite: no server URL given -- pass --server <url> or set TWING_SERVER.");
  if (!options.code) throw new Error("twing admin revoke-invite: --code <invite-code> is required");
  const token = requireAuth(serverUrl, "twing admin revoke-invite");
  const res = await authFetch(`${serverUrl}/v1/invites/${options.code}`, { method: "DELETE" }, token);
  const body = (await res.json().catch(() => ({}))) as { status?: string; error?: string };
  if (!res.ok) throw new Error(`twing admin revoke-invite: ${body.error ?? res.statusText}`);
  console.log(`twing admin revoke-invite: ${body.status}`);
}

export interface AdminRevokeDeveloperOptions {
  cwd: string;
  server?: string;
  developerId?: string;
}

export async function runAdminRevokeDeveloper(options: AdminRevokeDeveloperOptions): Promise<void> {
  const serverUrl = resolveServerUrl(options.cwd, options.server);
  if (!serverUrl) throw new Error("twing admin revoke-developer: no server URL given -- pass --server <url> or set TWING_SERVER.");
  if (!options.developerId) throw new Error("twing admin revoke-developer: --developer-id <id> is required");
  const token = requireAuth(serverUrl, "twing admin revoke-developer");
  const res = await authFetch(`${serverUrl}/v1/admin/developers/${encodeURIComponent(options.developerId)}/revoke`, { method: "POST" }, token);
  const body = (await res.json().catch(() => ({}))) as { status?: string; error?: string };
  if (!res.ok) throw new Error(`twing admin revoke-developer: ${body.error ?? res.statusText}`);
  console.log(`twing admin revoke-developer: ${body.status}`);
}

export interface AdminListDevelopersOptions {
  cwd: string;
  server?: string;
  orgId?: string;
}

export async function runAdminListDevelopers(options: AdminListDevelopersOptions): Promise<void> {
  const serverUrl = resolveServerUrl(options.cwd, options.server);
  if (!serverUrl) throw new Error("twing admin list-developers: no server URL given -- pass --server <url> or set TWING_SERVER.");
  const token = requireAuth(serverUrl, "twing admin list-developers");
  const params = options.orgId ? `?orgId=${encodeURIComponent(options.orgId)}` : "";
  const res = await authFetch(`${serverUrl}/v1/admin/developers${params}`, {}, token);
  const body = (await res.json().catch(() => ({}))) as { items?: { developerId: string; role: string }[]; error?: string };
  if (!res.ok) throw new Error(`twing admin list-developers: ${body.error ?? res.statusText}`);
  for (const d of body.items ?? []) {
    console.log(`${d.developerId}  role=${d.role}`);
  }
}
