/**
 * `twing design *` (design doc §17): register/resolve/list/reviews are the
 * design-gate's on-request commands, following `align.ts`'s pattern for
 * identity derivation and server calls. `enable-gate`/`disable-gate` wire
 * or unwire the PreToolUse hook entries (`wire-hooks.ts`).
 */

import { readConfig, findRepoRoot, computeProjectId, computeDeveloperId, authFetch } from "@twing/core";
import { hookBinaryPath } from "./install-hook.js";
import { wireDesignGate, unwireDesignGate } from "./wire-hooks.js";

interface RequiredConfig {
  serverUrl: string;
  authToken?: string;
}

function requireConfig(): RequiredConfig {
  const config = readConfig();
  if (!config.serverUrl) {
    throw new Error("twing design: no server configured -- run `twing init --server <url>` first");
  }
  return { serverUrl: config.serverUrl, authToken: config.authToken };
}

function splitList(value?: string): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const UNAUTHORIZED_HINT = "unauthorized -- run `twing init` again to re-authenticate";

interface DesignConflictJSON {
  conflictingDesignId: string;
  overlapKind: string;
  overlapDetail: string;
  conflictingSummary: string;
}

interface DesignCheckResponseJSON {
  error?: string;
  verdict?: "clean" | "overlap" | "constraint_flag";
  designId?: string;
  conflicts?: DesignConflictJSON[];
  constraint?: { statement: string; type: string };
}

async function parseJsonOrUnauthorized<T>(res: Response): Promise<T | { error: string }> {
  if (res.status === 401) return { error: UNAUTHORIZED_HINT };
  return (await res.json()) as T;
}

function printDesignVerdict(result: DesignCheckResponseJSON): void {
  if (result.error) {
    console.error(`twing design: ${result.error}`);
    return;
  }
  console.log(`verdict: ${result.verdict}  design: ${result.designId}`);
  if (result.verdict === "overlap") {
    for (const c of result.conflicts ?? []) {
      console.log(`  [${c.overlapKind}] conflicts with ${c.conflictingDesignId}: ${c.overlapDetail}`);
      console.log(`    their summary: ${c.conflictingSummary}`);
    }
    console.log(`  -> adopt the existing design, or run: twing design resolve --id ${result.designId} --justify "<reason>"`);
  } else if (result.verdict === "constraint_flag") {
    console.log(`  [${result.constraint?.type}] ${result.constraint?.statement}`);
    console.log(`  -> adjust your plan, or run: twing design resolve --id ${result.designId} --justify "<reason>"`);
  }
}

export interface RegisterOptions {
  cwd: string;
  session?: string;
  label?: string;
  summary?: string;
  creates?: string;
  touches?: string;
  dependsOn?: string;
}

/**
 * The Edit|Write PreToolUse gate looks up open designs by Claude Code's
 * exact session id. Confirmed live (2026-08-11, against a real gated
 * session): Claude Code sets `CLAUDE_CODE_SESSION_ID` in the environment a
 * Bash tool call runs in, and it matches the `session_id` the hook receives
 * -- registering with it and retrying an Edit actually unblocks. Falls back
 * to `--session` for callers/harnesses where that env var isn't set (spec
 * §9a's original open question -- still real for non-Claude-Code callers,
 * just resolved for the common case here).
 */
export async function runDesignRegister(options: RegisterOptions): Promise<void> {
  const { serverUrl, authToken } = requireConfig();
  const session = options.session ?? process.env.CLAUDE_CODE_SESSION_ID;
  if (!session) {
    throw new Error(
      "twing design register: no session id -- pass --session <id> explicitly (must be Claude Code's actual " +
        "session id; CLAUDE_CODE_SESSION_ID wasn't set in this environment). If unavailable, use plan mode instead: " +
        "ExitPlanMode registers a design automatically.",
    );
  }

  const repoRoot = findRepoRoot(options.cwd);
  const projectId = computeProjectId(repoRoot);
  const developerId = computeDeveloperId(repoRoot);

  const res = await authFetch(
    `${serverUrl}/v1/designs/check`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId,
        developerId,
        sessionId: session,
        agentLabel: options.label,
        summary: options.summary ?? "",
        creates: splitList(options.creates),
        touches: splitList(options.touches),
        dependsOn: splitList(options.dependsOn),
      }),
    },
    authToken,
  );
  printDesignVerdict(await parseJsonOrUnauthorized<DesignCheckResponseJSON>(res));
}

export interface ResolveOptions {
  id?: string;
  adopt?: string;
  justify?: string;
}

export async function runDesignResolve(options: ResolveOptions): Promise<void> {
  const { serverUrl, authToken } = requireConfig();
  if (!options.id) {
    throw new Error("twing design resolve: --id <designId> is required");
  }
  if (!options.adopt && !options.justify) {
    throw new Error('twing design resolve: pass --adopt <designId> or --justify "<reason>"');
  }

  const body = options.adopt
    ? { resolution: "adopted", adoptedDesignId: options.adopt }
    : { resolution: "justified_divergence", justification: options.justify };

  const res = await authFetch(
    `${serverUrl}/v1/designs/${options.id}/resolve`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    authToken,
  );
  console.log(JSON.stringify(await parseJsonOrUnauthorized(res), null, 2));
}

export interface ListOptions {
  cwd: string;
  status?: string;
}

export async function runDesignList(options: ListOptions): Promise<void> {
  const { serverUrl, authToken } = requireConfig();
  const repoRoot = findRepoRoot(options.cwd);
  const projectId = computeProjectId(repoRoot);

  const params = new URLSearchParams({ projectId });
  if (options.status) params.set("status", options.status);

  const res = await authFetch(`${serverUrl}/v1/designs?${params}`, {}, authToken);
  if (res.status === 401) {
    console.error(`twing design list: ${UNAUTHORIZED_HINT}`);
    return;
  }
  const body = (await res.json()) as { items?: { id: string; status: string; summary: string; creates: string[]; touches: string[] }[] };
  for (const d of body.items ?? []) {
    console.log(`${d.id}  [${d.status}]  ${d.summary || "(no summary)"}  creates=${d.creates.join(",")}  touches=${d.touches.join(",")}`);
  }
}

export interface ReviewsOptions {
  cwd: string;
  decide?: string;
  decision?: "approve" | "reject";
}

/** The one human-facing command in this set (§17.5): list pending
 * justified-divergence reviews, or decide one. */
export async function runDesignReviews(options: ReviewsOptions): Promise<void> {
  const { serverUrl, authToken } = requireConfig();
  const repoRoot = findRepoRoot(options.cwd);
  const projectId = computeProjectId(repoRoot);

  if (options.decide) {
    if (options.decision !== "approve" && options.decision !== "reject") {
      throw new Error("twing design reviews: --decide <reviewId> requires --decision approve|reject");
    }
    const res = await authFetch(
      `${serverUrl}/v1/reviews/${options.decide}/decide`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: options.decision }),
      },
      authToken,
    );
    console.log(JSON.stringify(await parseJsonOrUnauthorized(res), null, 2));
    return;
  }

  const res = await authFetch(`${serverUrl}/v1/reviews?projectId=${encodeURIComponent(projectId)}`, {}, authToken);
  if (res.status === 401) {
    console.error(`twing design reviews: ${UNAUTHORIZED_HINT}`);
    return;
  }
  const body = (await res.json()) as { items?: { id: string; designId: string; justification: string }[] };
  const items = body.items ?? [];
  if (items.length === 0) {
    console.log("twing design reviews: no pending reviews");
    return;
  }
  for (const r of items) {
    console.log(`${r.id}  design=${r.designId}  ${r.justification}`);
  }
}

export function runDesignEnableGate(options: { cwd: string }): void {
  const repoRoot = findRepoRoot(options.cwd);
  const hookPath = hookBinaryPath();
  const changed = wireDesignGate(repoRoot, hookPath);
  console.log(
    changed
      ? `twing design enable-gate: wired into ${repoRoot}/.claude/settings.json`
      : `twing design enable-gate: already wired in ${repoRoot}/.claude/settings.json`,
  );
}

export function runDesignDisableGate(options: { cwd: string }): void {
  const repoRoot = findRepoRoot(options.cwd);
  const hookPath = hookBinaryPath();
  const changed = unwireDesignGate(repoRoot, hookPath);
  console.log(
    changed ? `twing design disable-gate: removed from ${repoRoot}/.claude/settings.json` : `twing design disable-gate: wasn't wired`,
  );
}
