/**
 * `twing constraints *` -- its own top-level command surface (not folded
 * into `design *`), matching the server's own route grouping
 * (`/v1/constraints/*` is a distinct entity from `/v1/designs/*`) and the
 * precedent set for the staged/approval redesign this is meant to sit
 * alongside later (see task tracking: that redesign explicitly needs its
 * own CLI surface too, not `design reviews --decide`). Mirrors
 * `project.ts`'s style -- `--server`/`--project` flags, not `design.ts`'s
 * narrower "always the current repo's own committed coordinator" pattern,
 * since this is more of an admin action than a design-gate workflow step
 * tied to editing a specific checkout.
 */

import { findRepoRoot, computeProjectId, authFetch } from "@twing/core";
import { resolveServerUrl, requireAuth } from "./auth.js";

function resolveProjectId(cwd: string, explicit?: string): string {
  return explicit ?? computeProjectId(findRepoRoot(cwd));
}

export interface ConstraintsListOptions {
  cwd: string;
  server?: string;
  project?: string;
}

interface ConstraintJSON {
  id: string;
  type: string;
  statement: string;
  scope: string[];
}

export async function runConstraintsList(options: ConstraintsListOptions): Promise<void> {
  const serverUrl = resolveServerUrl(options.cwd, options.server);
  if (!serverUrl) throw new Error("twing constraints list: no server URL given -- pass --server <url> or set TWING_SERVER.");
  const projectId = resolveProjectId(options.cwd, options.project);
  const token = requireAuth(serverUrl, "twing constraints list");

  const res = await authFetch(`${serverUrl}/v1/constraints?projectId=${projectId}`, {}, token);
  if (res.status === 401) {
    console.error("twing constraints list: unauthorized -- run `twing login` to re-authenticate");
    return;
  }
  const body = (await res.json()) as { items?: ConstraintJSON[] };
  for (const c of body.items ?? []) {
    console.log(`${c.id}  [${c.type}]  ${c.statement}  scope=${c.scope.join(",")}`);
  }
}

export interface ConstraintsRemoveOptions {
  cwd: string;
  server?: string;
  id?: string;
}

/**
 * Unilateral admin removal -- same immediate-effect, admin-gated shape
 * `twing init`'s reseed already has for add/update, just extended to
 * cover deletion. Deliberately not staged/approved by a second admin (see
 * `ConstraintStore.remove`'s own doc comment) -- that redesign is tracked
 * separately as still-open follow-up work.
 */
export async function runConstraintsRemove(options: ConstraintsRemoveOptions): Promise<void> {
  const serverUrl = resolveServerUrl(options.cwd, options.server);
  if (!serverUrl) throw new Error("twing constraints remove: no server URL given -- pass --server <url> or set TWING_SERVER.");
  if (!options.id) throw new Error("twing constraints remove: --id <constraintId> is required");
  const token = requireAuth(serverUrl, "twing constraints remove");

  const res = await authFetch(`${serverUrl}/v1/constraints/${options.id}`, { method: "DELETE" }, token);
  if (res.status === 401) {
    console.error("twing constraints remove: unauthorized -- run `twing login` to re-authenticate");
    return;
  }
  const body = (await res.json()) as { removed?: boolean; error?: string };
  if (body.error) {
    console.error(`twing constraints remove: ${body.error}`);
    return;
  }
  console.log(`constraint ${options.id}: ${body.removed ? "removed" : "not found"}`);
}
