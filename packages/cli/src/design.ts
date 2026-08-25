/**
 * `twing design *` (design doc §17): register/resolve/list/reviews are the
 * design-gate's on-request commands, following `align.ts`'s pattern for
 * identity derivation and server calls. `enable-gate`/`disable-gate` set
 * the per-project local override (`gate-overrides.ts`) -- not hook-entry
 * wiring (`wire-hooks.ts`) anymore, since that's machine-global now;
 * unwiring a global entry would disable the gate for every repo, not just
 * this one.
 */

import { readConfig, getServerAuth, findRepoRoot, loadManifestFromFile, twingConfigPath, computeProjectId, computeDeveloperId, authFetch, isGateDisabled, setGateDisabled } from "@twing/core";

interface RequiredConfig {
  serverUrl: string;
  authToken?: string;
  /** §17 Phase 4: self-declared, attribution-only -- only ever reaches the
   * wire when this server is cached `noAuth: true` (a `full auth` server
   * ignores the header `authFetch` sets from it). Always computed, never
   * branched on here, matching `http.ts`'s "harmless to pass alongside a
   * real token" design. */
  developerId: string;
}

/** Resolves the coordinator for `repoRoot`'s own committed `.twing/twing.yml`
 * -- not a single global slot -- then looks up this machine's cached token
 * for that specific server (multi-server: a repo's coordinator and this
 * machine's auth for it are two separate lookups). */
function requireConfig(repoRoot: string): RequiredConfig {
  const manifest = loadManifestFromFile(twingConfigPath(repoRoot));
  const serverUrl = manifest.coordinator.serverUrl;
  if (!serverUrl) {
    throw new Error("twing design: no coordinator configured for this repo -- run `twing init --server <url>` once to set it up");
  }
  const authToken = getServerAuth(readConfig(), serverUrl)?.authToken;
  return { serverUrl, authToken, developerId: computeDeveloperId(repoRoot) };
}

function splitList(value?: string): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const UNAUTHORIZED_HINT = "unauthorized -- run `twing login` to re-authenticate";

interface DesignConflictJSON {
  conflictingDesignId: string;
  overlapKind: string;
  overlapDetail: string;
  conflictingSummary: string;
}

interface DesignCheckResponseJSON {
  error?: string;
  verdict?: "clean" | "overlap" | "constraint_flag" | "has_open_designs";
  /** Absent only for `"has_open_designs"` -- that verdict fires before any
   * row is created. See DesignVerdict's own doc comment in core/types.ts. */
  designId?: string;
  /** §17 design linking (2026-08) -- the design's own groupId, self-assigned
   * or caller-supplied. Copy this into a sibling repo's
   * `twing design register --group <id>` to link the two. */
  groupId?: string;
  conflicts?: DesignConflictJSON[];
  /** Every constraint the checked scope matched (2026-08-22, was a single
   * `constraint` object -- see design-checks.ts's matchConstraintsForPaths
   * doc comment for the full reasoning). */
  constraints?: { statement: string; type: string }[];
  /** 2026-08-19 severity split -- "warning" (tier 1's exactOverlap only,
   * currently) is display-only, undefined/"error" means today's original
   * blocking behavior. See DesignSeverity's doc comment in core/types.ts. */
  severity?: "warning" | "error";
  /** Set only for `"has_open_designs"` (2026-08-25, "force a choice"
   * registration-sprawl fix) -- the developer's other currently-open
   * designs, cross-project, found before this registration was created. */
  openDesigns?: { id: string; projectId: string; summary: string; lastActivityAt: number }[];
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
  // "has_open_designs" (2026-08-25) has no designId -- no row exists yet
  // for this verdict, see DesignCheckResult.designId's own doc comment.
  console.log(
    `verdict: ${result.verdict}${result.severity ? ` (${result.severity})` : ""}` + (result.designId ? `  design: ${result.designId}` : ""),
  );
  if (result.groupId) {
    // §17 design linking (2026-08): the copy-paste hint for linking a
    // sibling-repo registration to this one.
    console.log(`  group: ${result.groupId}  (registering a linked design in another repo? pass --group ${result.groupId})`);
  }
  if (result.verdict === "overlap" && result.severity === "warning") {
    // Display-only (2026-08-19 severity split): recorded for visibility,
    // design stays open, no action required.
    for (const c of result.conflicts ?? []) {
      console.log(`  [${c.overlapKind}] conflicts with ${c.conflictingDesignId}: ${c.overlapDetail}`);
      console.log(`    their summary: ${c.conflictingSummary}`);
    }
    console.log(`  (warning only -- no action needed; visible in the dashboard's design detail/activity feed)`);
  } else if (result.verdict === "overlap") {
    for (const c of result.conflicts ?? []) {
      console.log(`  [${c.overlapKind}] conflicts with ${c.conflictingDesignId}: ${c.overlapDetail}`);
      console.log(`    their summary: ${c.conflictingSummary}`);
    }
    console.log(`  -> adopt the existing design, or run: twing design resolve --id ${result.designId} --justify "<reason>"`);
  } else if (result.verdict === "constraint_flag") {
    for (const c of result.constraints ?? []) {
      console.log(`  [${c.type}] ${c.statement}`);
    }
    console.log(`  -> adjust your plan, or run: twing design resolve --id ${result.designId} --justify "<reason>"`);
  } else if (result.verdict === "has_open_designs") {
    // "Force a choice" registration-sprawl fix (2026-08-25): no row was
    // created for this call -- nothing to point `resolve`/`close` at yet.
    for (const d of result.openDesigns ?? []) {
      console.log(`  open: ${d.id}  (project ${d.projectId}) -- "${d.summary || "no summary"}"`);
    }
    console.log(`  -> if this is a continuation, link it: twing design register ... --group <id>`);
    console.log(`  -> if that work is done, close it first: twing design close --id <id>`);
    console.log(`  -> if this is genuinely new, override: twing design register ... --force`);
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
  /** §17 design linking (2026-08): links this registration to an existing
   * design (typically in another repo) sharing the same unit of work --
   * pass the `groupId` printed by that design's own registration. */
  group?: string;
  /** "Force a choice" registration-sprawl fix (2026-08-25): explicit
   * override of the has-open-designs pre-registration check -- for a
   * genuinely new, unrelated design registered while another is still
   * open. See DesignCheckRequestBody.force's doc comment (packages/server). */
  force?: boolean;
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
  const repoRoot = findRepoRoot(options.cwd);
  const { serverUrl, authToken, developerId } = requireConfig(repoRoot);
  const session = options.session ?? process.env.CLAUDE_CODE_SESSION_ID;
  if (!session) {
    throw new Error(
      "twing design register: no session id -- pass --session <id> explicitly (must be Claude Code's actual " +
        "session id; CLAUDE_CODE_SESSION_ID wasn't set in this environment). If unavailable, use plan mode instead: " +
        "ExitPlanMode registers a design automatically.",
    );
  }

  // The only field genuinely required to make a registration meaningful --
  // found live, 2026-08-17: `register` was the one subcommand in this file
  // with no required-arg check at all (every sibling -- resolve/amend/
  // resume -- already validates), so a malformed call (e.g. `--help`
  // mis-parsed as a real invocation, see runDesignCommand's own fix) fell
  // through with `summary: options.summary ?? ""` and silently registered
  // a real, empty, unrecoverable-looking design against the live
  // coordinator instead of failing loudly. The error text itself was
  // widened the same day (still found live -- this was the "just throwing
  // might not be enough" follow-up): an agent hitting this for the first
  // time, usually from the hook's own "no design registered" deny, has no
  // other cue about what a summary is *for* -- it's the one field every
  // other session and human reviewer sees when work overlaps theirs, not
  // free-form scratch text, so a generic "field required" message invites
  // a generic filler value instead of a real answer.
  if (!options.summary) {
    throw new Error(
      'twing design register: --summary "..." is required -- describe the concrete thing you are trying to ' +
        "achieve in this session (not a placeholder or restatement of the command). This is what shows up to " +
        "other sessions and human reviewers when your work overlaps theirs, so it needs to actually say what " +
        'you\'re building: e.g. --summary "Add exponential backoff with jitter to RetryPolicy so outbound HTTP ' +
        'calls survive transient failures" rather than --summary "make changes" or --summary "fix bug".',
    );
  }

  const projectId = computeProjectId(repoRoot);

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
        ...(options.group ? { groupId: options.group } : {}),
        ...(options.force ? { force: true } : {}),
      }),
    },
    authToken,
    developerId,
  );
  printDesignVerdict(await parseJsonOrUnauthorized<DesignCheckResponseJSON>(res));
}

export interface ResolveOptions {
  cwd: string;
  id?: string;
  adopt?: string;
  justify?: string;
}

export async function runDesignResolve(options: ResolveOptions): Promise<void> {
  const repoRoot = findRepoRoot(options.cwd);
  const { serverUrl, authToken, developerId } = requireConfig(repoRoot);
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
    developerId,
  );
  console.log(JSON.stringify(await parseJsonOrUnauthorized(res), null, 2));
}

export interface CloseOptions {
  cwd: string;
  id?: string;
}

/**
 * §17.6: explicit close -- hits the same `/v1/designs/:id/close` route the
 * `SessionEnd` hook already calls best-effort for every open/flagged/
 * dormant design in a session, just on demand for one specific design
 * instead. Exists so a design doesn't have to sit open until session end
 * (or the TTL sweep, `design-store.ts`'s `sweepExpired`) just because the
 * work it named is already done -- an agent that finishes a task and
 * doesn't close its own design leaves stale "open" scope other
 * sessions/reviewers see as still-live. No-op (not an error) on a design
 * that's already closed/superseded/expired -- `designs.close` only
 * transitions `open`/`flagged`/`dormant`, so this is safe to call more
 * than once.
 */
export async function runDesignClose(options: CloseOptions): Promise<void> {
  const repoRoot = findRepoRoot(options.cwd);
  const { serverUrl, authToken, developerId } = requireConfig(repoRoot);
  if (!options.id) {
    throw new Error("twing design close: --id <designId> is required");
  }

  const res = await authFetch(`${serverUrl}/v1/designs/${options.id}/close`, { method: "PATCH" }, authToken, developerId);
  console.log(JSON.stringify(await parseJsonOrUnauthorized(res), null, 2));
}

export interface AmendOptions {
  cwd: string;
  id?: string;
  touches?: string;
  creates?: string;
  dependsOn?: string;
  /** Appended onto the design's existing summary as a dated `Update:` entry
   * (server-side, design-checks.ts's `appendSummaryUpdate`) -- not a
   * replace. Originally a full replace (2026-08-17, the escape hatch for a
   * design mis-registered with an empty/garbage summary), reversed
   * 2026-08-18: a plain replace meant a scope-only amend that just wanted
   * to explain *why* silently destroyed the design's entire original
   * context instead. */
  summary?: string;
  /** §17 design linking (2026-08): join (or move to) a different group
   * after registration -- same no-existence-check trust model as
   * `register --group` (a groupId is a caller-supplied label, never
   * validated against a real design). Printed back via the shared
   * `group: <id>` hint in `printDesignVerdict`, same as `register`/`check`. */
  group?: string;
}

/**
 * §17 scope enforcement (2026-08): the escape hatch for legitimately
 * touching a file that wasn't declared at registration time, or (2026-08-17)
 * fixing up a bad summary. The server re-runs the full syntactic check
 * against the *merged* scope (and the new summary, if given -- it feeds
 * design-checks.ts's Jaccard summary-similarity overlap tier same as any
 * other field) before persisting anything -- this can't be used to
 * silently launder a scope expansion past overlap/constraint detection, it
 * can only be rejected the same way initial registration can. Response
 * shape matches `/v1/designs/check`'s, so `printDesignVerdict`'s existing
 * "adopt the existing design, or run twing design resolve ..." hint
 * applies unchanged.
 */
export async function runDesignAmend(options: AmendOptions): Promise<void> {
  const repoRoot = findRepoRoot(options.cwd);
  const { serverUrl, authToken, developerId } = requireConfig(repoRoot);
  if (!options.id) {
    throw new Error("twing design amend: --id <designId> is required");
  }
  if (!options.touches && !options.creates && !options.dependsOn && !options.summary && !options.group) {
    throw new Error("twing design amend: pass at least one of --touches, --creates, --depends-on, --summary, --group");
  }

  const res = await authFetch(
    `${serverUrl}/v1/designs/${options.id}/amend`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        addTouches: splitList(options.touches),
        addCreates: splitList(options.creates),
        addDependsOn: splitList(options.dependsOn),
        ...(options.summary ? { summary: options.summary } : {}),
        ...(options.group ? { groupId: options.group } : {}),
      }),
    },
    authToken,
    developerId,
  );
  printDesignVerdict(await parseJsonOrUnauthorized<DesignCheckResponseJSON>(res));
}

export interface ResumeOptions {
  cwd: string;
  id?: string;
  session?: string;
  touches?: string;
  creates?: string;
  dependsOn?: string;
}

/**
 * §17 design lifecycle (2026-08): reactivates a *dormant* design -- always
 * an explicit, deliberate call (never triggered automatically by a file
 * match; see `/v1/designs/scope-match`'s `"dormant"` state, which is what
 * points a session here in the first place). Cross-developer by design:
 * any project member can pick up a design someone else parked, not just
 * the original session/developer -- the server reassigns both to whoever
 * calls this. Unlike `amend`, a scope delta is optional (resuming with no
 * new files is a valid call). Session resolution mirrors `register`'s.
 */
export async function runDesignResume(options: ResumeOptions): Promise<void> {
  const repoRoot = findRepoRoot(options.cwd);
  const { serverUrl, authToken, developerId } = requireConfig(repoRoot);
  if (!options.id) {
    throw new Error("twing design resume: --id <designId> is required");
  }
  const session = options.session ?? process.env.CLAUDE_CODE_SESSION_ID;
  if (!session) {
    throw new Error(
      "twing design resume: no session id -- pass --session <id> explicitly (must be Claude Code's actual " +
        "session id; CLAUDE_CODE_SESSION_ID wasn't set in this environment).",
    );
  }

  const res = await authFetch(
    `${serverUrl}/v1/designs/${options.id}/resume`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: session,
        addTouches: splitList(options.touches),
        addCreates: splitList(options.creates),
        addDependsOn: splitList(options.dependsOn),
      }),
    },
    authToken,
    developerId,
  );
  printDesignVerdict(await parseJsonOrUnauthorized<DesignCheckResponseJSON>(res));
}

export interface ListOptions {
  cwd: string;
  status?: string;
  /** Filters to designs registered under the caller's own `developerId` --
   * purely client-side (the server response already carries `developerId`
   * per row; this just narrows what gets printed), so no new query param.
   * Point of this flag: give a session hitting `noDesignReason()`'s "no
   * design registered" deny a fast way to check whether it already has an
   * open design elsewhere in the project it should join (`amend --group`)
   * instead of registering a fresh one for the same ongoing effort. */
  mine?: boolean;
}

/** Coarse, human-readable approximation ("3h ago", "2d ago") -- mirrors
 * hook/design_gate.go's dormantSinceText, just enough to judge "recently"
 * vs "a while ago", not a precise timestamp. */
function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export async function runDesignList(options: ListOptions): Promise<void> {
  const repoRoot = findRepoRoot(options.cwd);
  const { serverUrl, authToken, developerId } = requireConfig(repoRoot);
  const projectId = computeProjectId(repoRoot);

  const params = new URLSearchParams({ projectId });
  if (options.status) params.set("status", options.status);

  const res = await authFetch(`${serverUrl}/v1/designs?${params}`, {}, authToken, developerId);
  if (res.status === 401) {
    console.error(`twing design list: ${UNAUTHORIZED_HINT}`);
    return;
  }
  const body = (await res.json()) as {
    items?: { id: string; status: string; summary: string; creates: string[]; touches: string[]; lastActivityAt?: number; developerId: string }[];
  };
  const items = options.mine ? (body.items ?? []).filter((d) => d.developerId === developerId) : (body.items ?? []);
  for (const d of items) {
    const activity = d.lastActivityAt ? `  last activity ${relativeTime(d.lastActivityAt)}` : "";
    console.log(`${d.id}  [${d.status}]${activity}  ${d.summary || "(no summary)"}  creates=${d.creates.join(",")}  touches=${d.touches.join(",")}`);
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
  const repoRoot = findRepoRoot(options.cwd);
  const { serverUrl, authToken, developerId } = requireConfig(repoRoot);
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
      developerId,
    );
    console.log(JSON.stringify(await parseJsonOrUnauthorized(res), null, 2));
    return;
  }

  const res = await authFetch(`${serverUrl}/v1/reviews?projectId=${encodeURIComponent(projectId)}`, {}, authToken, developerId);
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
  const projectId = computeProjectId(repoRoot);
  if (!isGateDisabled(projectId)) {
    console.log(`twing design enable-gate: already enabled for this project`);
    return;
  }
  setGateDisabled(projectId, false);
  console.log(`twing design enable-gate: enabled for this project`);
}

export function runDesignDisableGate(options: { cwd: string }): void {
  const repoRoot = findRepoRoot(options.cwd);
  const projectId = computeProjectId(repoRoot);
  if (isGateDisabled(projectId)) {
    console.log(`twing design disable-gate: already disabled for this project`);
    return;
  }
  setGateDisabled(projectId, true);
  console.log(`twing design disable-gate: disabled for this project (other repos on this machine are unaffected)`);
}
