/**
 * `twing project *` (§17.10 hardening): a project admin onboarding/removing
 * contributors for their own repo specifically -- boundary 3 of the three
 * trust boundaries in `identity-store.ts`'s header comment. Mirrors
 * `admin.ts`'s style, scoped by `--project` (defaulting to the current
 * repo's `computeProjectId`, same pattern `design.ts` already uses).
 */

import { findRepoRoot, computeProjectId, authFetch, twingConfigPath } from "@twing/core";
import * as fs from "node:fs";
import { resolveServerUrl, requireAuth } from "./auth.js";
import { enableInstallEnforcement, disableInstallEnforcement } from "./enforce-hooks.js";

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

/**
 * Admin-driven install enforcement (`enforce-hooks.ts`): unlike every other
 * command in this file, deliberately no server call, no `--server`/auth
 * flag. The real authorization boundary here is GitHub's own branch
 * protection / PR review on the committed `.claude/settings.json` file
 * itself, not twing's server-side role system -- gating a local file write
 * behind a network auth check would be theater (it wouldn't stop anyone
 * from hand-editing the JSON and opening a rejectable PR regardless), and
 * would add a needless network dependency to a purely-local operation. For
 * the same reason there's no machine-local override file
 * (`gate-overrides.ts`'s pattern) for this feature either: that file exists
 * because the *design gate*'s wiring is machine-global and a per-repo
 * override has to live somewhere local; this feature's whole artifact
 * already lives in the repo, so there's nothing to override locally.
 */
export interface ProjectEnforcementOptions {
  cwd: string;
}

export function runProjectEnableEnforcement(options: ProjectEnforcementOptions): void {
  const repoRoot = findRepoRoot(options.cwd);
  if (!fs.existsSync(twingConfigPath(repoRoot))) {
    console.warn("twing project enable-enforcement: this repo has no .twing/twing.yml yet -- the hook will no-op until `twing init` sets one up");
  }
  if (!enableInstallEnforcement(repoRoot)) {
    console.log("twing project enable-enforcement: already present in .claude/settings.json");
    return;
  }
  // Both paths, explicitly. They are the same artifact, and committing only
  // one leaves the repo un-enforced with nothing to say so.
  console.log(
    "twing project enable-enforcement: wrote .twing/bootstrap-hook.sh and the entries in " +
      ".claude/settings.json -- commit and push BOTH files (or open a PR) so your team inherits it.",
  );
}

export function runProjectDisableEnforcement(options: ProjectEnforcementOptions): void {
  const repoRoot = findRepoRoot(options.cwd);
  if (!disableInstallEnforcement(repoRoot)) {
    console.log("twing project disable-enforcement: nothing to remove -- not present in .claude/settings.json");
    return;
  }
  console.log(
    "twing project disable-enforcement: removed from .claude/settings.json -- commit and push this file (or " +
      "open a PR) so your team stops being gated by it.",
  );
}
