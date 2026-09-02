/**
 * `twing design *` (design doc §17): register/resolve/list/reviews are the
 * design-gate's on-request commands, following `align.ts`'s pattern for
 * identity derivation and server calls. `enable-gate`/`disable-gate` set
 * the per-project local override (`gate-overrides.ts`) -- not hook-entry
 * wiring (`wire-hooks.ts`) anymore, since that's machine-global now;
 * unwiring a global entry would disable the gate for every repo, not just
 * this one.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
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

/**
 * Existence-check advisory (2026-08-31): `touches` is only ever meant to
 * name files that already exist under this repo -- unlike `creates`, which
 * legitimately doesn't. Found live: a design's `touches` can be
 * project-mismatched (registered against the wrong repo entirely) or, for
 * a genuinely multi-repo plan, only partially relevant here, and neither
 * looks any different from a correct registration until a human goes
 * looking. Deliberately advisory only, printed to stdout rather than
 * thrown -- a caller-supplied path that's merely relative to a
 * subdirectory, or a real typo, shouldn't block a registration a human
 * clearly meant to make; this just makes a wrong-repo case visible
 * immediately instead of silently, same reasoning as the equivalent check
 * in hook/design_gate.go's ExitPlanMode path. Fires only when *none* of
 * the declared touches exist -- one match is enough to assume this repo is
 * plausible and stay quiet.
 */
function warnIfTouchesMissing(repoRoot: string, touches: string[]): void {
  if (touches.length === 0) return;
  const anyExists = touches.some((t) => existsSync(join(repoRoot, t)));
  if (anyExists) return;
  console.warn(
    `twing design: none of the declared --touches files exist under ${repoRoot}. If this design is actually about a ` +
      `different repo, move it: twing design amend --id <id> --reassign-project (run from the correct repo) -- or ` +
      `close and re-register if that's refused (already has reviews/threads attached). If this design genuinely ` +
      `spans multiple repos, register a separate design in each one with that repo's own file list, then link them ` +
      `with the same --group.`,
  );
}

interface DesignConflictJSON {
  conflictingDesignId: string;
  overlapKind: string;
  overlapDetail: string;
  conflictingSummary: string;
}

interface DesignCheckResponseJSON {
  error?: string;
  /** 2026-08-26 terminology simplification: renamed from
   * `"clean" | "overlap" | "constraint_flag"`. Only `"file_overlap"` and
   * `"constraint_violation"` can come back from
   * `/v1/designs/check`/`amend`/`resume` (design-checks.ts tiers 1/3);
   * `"symbol_conflict"`/`"llm_divergence"` only ever arise from
   * `/v1/claims` or the async semantic-comparator pass, never this
   * synchronous response. See DesignVerdict's own doc comment,
   * core/types.ts, for the full four-bucket model. (A fifth value,
   * `"has_open_designs"`, existed briefly for this response 2026-08-25 to
   * 2026-08-31 -- retired, see DesignVerdict's doc comment for why.) */
  verdict?: "clean" | "file_overlap" | "constraint_violation";
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
  /** Change D (2026-08-31): only ever populated by a successful
   * `--reassign-project` amend -- the design's new home, echoed back so
   * `printDesignVerdict` can confirm the move actually happened. */
  projectId?: string;
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
  console.log(`verdict: ${result.verdict}` + (result.designId ? `  design: ${result.designId}` : ""));
  if (result.projectId) {
    // Change D (2026-08-31): only a successful --reassign-project amend
    // sets this -- confirms the move, mirroring Change A's "report what
    // actually happened" reasoning for ExitPlanMode's own registration.
    console.log(`  now in project: ${result.projectId}`);
  }
  if (result.groupId) {
    // §17 design linking (2026-08): the copy-paste hint for linking a
    // sibling-repo registration to this one.
    console.log(`  group: ${result.groupId}  (registering a linked design in another repo? pass --group ${result.groupId})`);
  }
  // 2026-08-26: blocking is now a static function of `verdict` alone --
  // `"file_overlap"` (renamed from `"overlap"`) is always advisory-only,
  // `"constraint_violation"` (renamed from `"constraint_flag"`) always
  // blocks. No more severity branch to check within a single verdict.
  if (result.verdict === "file_overlap") {
    for (const c of result.conflicts ?? []) {
      console.log(`  [${c.overlapKind}] conflicts with ${c.conflictingDesignId}: ${c.overlapDetail}`);
      console.log(`    their summary: ${c.conflictingSummary}`);
    }
    console.log(`  (advisory only -- no action needed; visible in the dashboard's design detail/activity feed)`);
  } else if (result.verdict === "constraint_violation") {
    for (const c of result.constraints ?? []) {
      console.log(`  [${c.type}] ${c.statement}`);
    }
    console.log(`  -> adjust your plan, or run: twing design resolve --id ${result.designId} --justify "<reason>" (a project admin will need to approve)`);
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
  const touches = splitList(options.touches);
  warnIfTouchesMissing(repoRoot, touches);

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
        touches,
        dependsOn: splitList(options.dependsOn),
        ...(options.group ? { groupId: options.group } : {}),
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
  /** `--merge`: narrow this flagged design's own scope to the given
   * `--touches`/`--creates` (replacing, not adding), dropping the overlap
   * with the counterpart. The server re-checks the narrowed shape and only
   * clears the flag if it comes back clean. */
  merge?: boolean;
  touches?: string;
  creates?: string;
}

/** The four ways out of a peer-vs-peer design flag, in the same order the
 * Go hook's deny message lists them -- shared so the interactive prompt and
 * that message can't drift. */
const RESOLVE_CHOICES = [
  "Adopt their design  (drop yours, build on theirs)",
  "Split the work  (narrow your scope so it stops overlapping)",
  "Keep yours separate  (justify why these don't actually overlap)",
  "Drop yours  (that work is done / no longer applies)",
] as const;

async function promptResolution(id: string): Promise<{ resolution: string; [k: string]: unknown } | undefined> {
  if (!process.stdin.isTTY) {
    throw new Error('twing design resolve: pass --adopt <designId>, --justify "<reason>", or --merge --touches <files> (no TTY for the interactive picker)');
  }
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`\nResolving design ${id} -- how do you want to resolve this conflict?\n`);
    RESOLVE_CHOICES.forEach((c, i) => console.log(`  ${i + 1}. ${c}`));
    const pick = (await rl.question("\nChoose 1-4 (or q to cancel): ")).trim();
    switch (pick) {
      case "1": {
        const other = (await rl.question("Their design id (--adopt): ")).trim();
        return other ? { resolution: "adopted", adoptedDesignId: other } : undefined;
      }
      case "2": {
        const touches = (await rl.question("Paths that stay on YOUR side, comma-separated (--touches): ")).trim();
        const creates = (await rl.question("...and any new files you'll still create (--creates, blank for none): ")).trim();
        return { resolution: "merged", mergedTouches: splitList(touches), mergedCreates: splitList(creates) };
      }
      case "3": {
        const why = (await rl.question("Why are these genuinely separate? ")).trim();
        return why ? { resolution: "justified_divergence", justification: why } : undefined;
      }
      case "4":
        return { resolution: "__close__" };
      default:
        return undefined;
    }
  } finally {
    rl.close();
  }
}

export async function runDesignResolve(options: ResolveOptions): Promise<void> {
  const repoRoot = findRepoRoot(options.cwd);
  const { serverUrl, authToken, developerId } = requireConfig(repoRoot);
  if (!options.id) {
    throw new Error("twing design resolve: --id <designId> is required");
  }

  let body: { resolution: string; [k: string]: unknown };
  if (options.adopt) {
    body = { resolution: "adopted", adoptedDesignId: options.adopt };
  } else if (options.merge) {
    body = { resolution: "merged", mergedTouches: splitList(options.touches), mergedCreates: splitList(options.creates) };
  } else if (options.justify) {
    body = { resolution: "justified_divergence", justification: options.justify };
  } else {
    const chosen = await promptResolution(options.id);
    if (!chosen) {
      console.log("twing design resolve: cancelled, nothing changed.");
      return;
    }
    if (chosen.resolution === "__close__") {
      await runDesignClose({ cwd: options.cwd, id: options.id });
      return;
    }
    body = chosen;
  }

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
  const result = (await parseJsonOrUnauthorized(res)) as { error?: string; status?: string; reviewId?: string; verdict?: string };
  // 2026-08-26 self-approve: `/v1/designs/:id/resolve` now distinguishes
  // "resolved" (no constraint hit in the mix -- decided immediately, the
  // design is unblocked right now) from "pending_review" (a constraint
  // violation is in the mix -- the only bucket where a project admin's
  // decide is still required). See DesignVerdict's doc comment,
  // core/types.ts, for the full four-bucket model this line reflects.
  if (!result.error) {
    if (result.status === "resolved") {
      const via = body.resolution === "merged" ? "narrowed scope re-checked clean" : "self-approved, no admin needed";
      console.log(`twing design: unblocked -- ${via}${result.reviewId ? ` (review ${result.reviewId})` : ""}.`);
    } else if (result.status === "pending_review") {
      console.log(`twing design: waiting on a project admin -- run \`twing design reviews --decide ${result.reviewId} --decision approve\` (as an admin) to unblock.`);
    } else if (result.status === "flagged") {
      // `--merge` only: the narrowed scope still didn't come back clean.
      console.log(`twing design: still blocked -- the narrowed scope re-checked as "${result.verdict}". Nothing was changed; widen the narrowing or pick another resolution.`);
    }
  }
  console.log(JSON.stringify(result, null, 2));
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
  /** Change D (2026-08-31, design-gate registration-flow fixes): move this
   * design to the project resolved from `cwd` -- run from the correct
   * repo, no raw project-id hash to paste, same resolution `register`
   * already uses. Mutually exclusive with every other field on this
   * type -- it's a distinct action (`reassignProjectId` server-side), not
   * a scope amend, and is checked first in `runDesignAmend` below. */
  reassignProject?: boolean;
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

  // Change D: a fix-in-place for a wrong-project registration -- see
  // AmendOptions.reassignProject's own doc comment for why this is
  // checked first and is mutually exclusive with every other amend shape.
  if (options.reassignProject) {
    if (options.touches || options.creates || options.dependsOn || options.summary || options.group) {
      throw new Error(
        "twing design amend: --reassign-project can't be combined with --touches/--creates/--depends-on/--summary/--group -- " +
          "it's a distinct action (moving the design), run it on its own",
      );
    }
    const newProjectId = computeProjectId(repoRoot);
    const res = await authFetch(
      `${serverUrl}/v1/designs/${options.id}/amend`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reassignProjectId: newProjectId }) },
      authToken,
      developerId,
    );
    printDesignVerdict(await parseJsonOrUnauthorized<DesignCheckResponseJSON>(res));
    return;
  }

  if (!options.touches && !options.creates && !options.dependsOn && !options.summary && !options.group) {
    throw new Error("twing design amend: pass at least one of --touches, --creates, --depends-on, --summary, --group, --reassign-project");
  }
  const addTouches = splitList(options.touches);
  warnIfTouchesMissing(repoRoot, addTouches);

  const res = await authFetch(
    `${serverUrl}/v1/designs/${options.id}/amend`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        addTouches,
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

  const resumeTouches = splitList(options.touches);
  warnIfTouchesMissing(repoRoot, resumeTouches);

  const res = await authFetch(
    `${serverUrl}/v1/designs/${options.id}/resume`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: session,
        addTouches: resumeTouches,
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
    items?: { id: string; status: string; blockedReason?: string; summary: string; creates: string[]; touches: string[]; lastActivityAt?: number; developerId: string }[];
  };
  const items = options.mine ? (body.items ?? []).filter((d) => d.developerId === developerId) : (body.items ?? []);
  for (const d of items) {
    const activity = d.lastActivityAt ? `  last activity ${relativeTime(d.lastActivityAt)}` : "";
    // blockedReason (2026-08-26): only ever set while status is "flagged"
    // -- see its own doc comment (@twing/core). Printed right next to the
    // status bracket so `design list` says *why* a design is flagged
    // instead of just that it is, same motivation as the hook's deny
    // message now naming the bucket instead of one generic sentence.
    const reason = d.blockedReason ? ` (${d.blockedReason})` : "";
    console.log(`${d.id}  [${d.status}]${reason}${activity}  ${d.summary || "(no summary)"}  creates=${d.creates.join(",")}  touches=${d.touches.join(",")}`);
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
