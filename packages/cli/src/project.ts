/**
 * `twing project *` (§17.10 hardening): a project admin onboarding/removing
 * contributors for their own repo specifically -- boundary 3 of the three
 * trust boundaries in `identity-store.ts`'s header comment. Mirrors
 * `admin.ts`'s style, scoped by `--project` (defaulting to the current
 * repo's `computeProjectId`, same pattern `design.ts` already uses).
 */

import { findRepoRoot, computeProjectId, authFetch } from "@twing/core";
import { resolveServerUrl, requireAuth } from "./auth.js";

type Role = "admin" | "member";

function resolveProjectId(cwd: string, explicit?: string): string {
  return explicit ?? computeProjectId(findRepoRoot(cwd));
}

export interface ProjectInviteOptions {
  cwd: string;
  server?: string;
  project?: string;
  label?: string;
  role?: Role;
}

interface InviteResponseJSON {
  code?: string;
  expiresAt?: number;
  error?: string;
}

export async function runProjectInvite(options: ProjectInviteOptions): Promise<void> {
  const serverUrl = resolveServerUrl(options.cwd, options.server);
  if (!serverUrl) throw new Error("twing project invite: no server URL given -- pass --server <url> or set TWING_SERVER.");
  if (!options.label) throw new Error("twing project invite: --label <email> is required");
  const projectId = resolveProjectId(options.cwd, options.project);
  const token = requireAuth(serverUrl, "twing project invite");

  const res = await authFetch(
    `${serverUrl}/v1/projects/${projectId}/invites`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: options.label, role: options.role }),
    },
    token,
  );
  const body = (await res.json().catch(() => ({}))) as InviteResponseJSON;
  if (!res.ok || !body.code) throw new Error(`twing project invite: ${body.error ?? res.statusText}`);
  console.log(`twing project invite: code = ${body.code}  (expires ${new Date(body.expiresAt ?? 0).toISOString()})`);
  console.log(
    `twing project invite: hand this to ${options.label} -- they redeem it with \`twing keygen --invite ${body.code}\` ` +
      `(or \`twing init --invite ${body.code}\` from their checkout).`,
  );
}

export interface ProjectListInvitesOptions {
  cwd: string;
  server?: string;
  project?: string;
}

interface InviteListItem {
  code: string;
  role: string;
  label: string;
  expiresAt: number;
  consumedAt?: number;
}

export async function runProjectListInvites(options: ProjectListInvitesOptions): Promise<void> {
  const serverUrl = resolveServerUrl(options.cwd, options.server);
  if (!serverUrl) throw new Error("twing project list-invites: no server URL given -- pass --server <url> or set TWING_SERVER.");
  const projectId = resolveProjectId(options.cwd, options.project);
  const token = requireAuth(serverUrl, "twing project list-invites");
  const res = await authFetch(`${serverUrl}/v1/projects/${projectId}/invites`, {}, token);
  const body = (await res.json().catch(() => ({}))) as { items?: InviteListItem[]; error?: string };
  if (!res.ok) throw new Error(`twing project list-invites: ${body.error ?? res.statusText}`);
  for (const i of body.items ?? []) {
    const status = i.consumedAt ? "consumed" : Date.now() > i.expiresAt ? "expired" : "pending";
    console.log(`${i.code}  [${status}]  ${i.label}  role=${i.role}`);
  }
}

export interface ProjectRevokeInviteOptions {
  cwd: string;
  server?: string;
  code?: string;
}

export async function runProjectRevokeInvite(options: ProjectRevokeInviteOptions): Promise<void> {
  const serverUrl = resolveServerUrl(options.cwd, options.server);
  if (!serverUrl) throw new Error("twing project revoke-invite: no server URL given -- pass --server <url> or set TWING_SERVER.");
  if (!options.code) throw new Error("twing project revoke-invite: --code <invite-code> is required");
  const token = requireAuth(serverUrl, "twing project revoke-invite");
  const res = await authFetch(`${serverUrl}/v1/invites/${options.code}`, { method: "DELETE" }, token);
  const body = (await res.json().catch(() => ({}))) as { status?: string; error?: string };
  if (!res.ok) throw new Error(`twing project revoke-invite: ${body.error ?? res.statusText}`);
  console.log(`twing project revoke-invite: ${body.status}`);
}

export interface ProjectRemoveDeveloperOptions {
  cwd: string;
  server?: string;
  project?: string;
  developerId?: string;
}

export async function runProjectRemoveDeveloper(options: ProjectRemoveDeveloperOptions): Promise<void> {
  const serverUrl = resolveServerUrl(options.cwd, options.server);
  if (!serverUrl) throw new Error("twing project remove-developer: no server URL given -- pass --server <url> or set TWING_SERVER.");
  if (!options.developerId) throw new Error("twing project remove-developer: --developer-id <id> is required");
  const projectId = resolveProjectId(options.cwd, options.project);
  const token = requireAuth(serverUrl, "twing project remove-developer");
  const res = await authFetch(`${serverUrl}/v1/projects/${projectId}/developers/${encodeURIComponent(options.developerId)}`, { method: "DELETE" }, token);
  const body = (await res.json().catch(() => ({}))) as { status?: string; error?: string };
  if (!res.ok) throw new Error(`twing project remove-developer: ${body.error ?? res.statusText}`);
  console.log(`twing project remove-developer: ${body.status}`);
}

export interface ProjectListDevelopersOptions {
  cwd: string;
  server?: string;
  project?: string;
}

export async function runProjectListDevelopers(options: ProjectListDevelopersOptions): Promise<void> {
  const serverUrl = resolveServerUrl(options.cwd, options.server);
  if (!serverUrl) throw new Error("twing project list-developers: no server URL given -- pass --server <url> or set TWING_SERVER.");
  const projectId = resolveProjectId(options.cwd, options.project);
  const token = requireAuth(serverUrl, "twing project list-developers");
  const res = await authFetch(`${serverUrl}/v1/projects/${projectId}/developers`, {}, token);
  const body = (await res.json().catch(() => ({}))) as { items?: { developerId: string; role: string }[]; error?: string };
  if (!res.ok) throw new Error(`twing project list-developers: ${body.error ?? res.statusText}`);
  for (const d of body.items ?? []) {
    console.log(`${d.developerId}  role=${d.role}`);
  }
}
