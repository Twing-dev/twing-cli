/**
 * Overlap detection (design doc §17.4 / spec §6) -- the synchronous half of
 * the four-bucket design-conflict model (2026-08-26 terminology
 * simplification; see `DesignVerdict`'s doc comment in core/types.ts for
 * the full model). Two tiers now, cheapest first: exact `creates`/`touches`
 * overlap (`"file_overlap"`, always advisory, never blocks), then
 * constraint match (`"constraint_violation"`, always blocks). `"symbol_conflict"`
 * (real-edit collisions, sourced from Claims) lives in `checks.ts`/
 * `design-divergence.ts`; `"llm_divergence"` lives in
 * `design-semantic-check.ts`'s async comparator -- neither runs here.
 *
 * (2026-08-19, removed: a "dependency collision" tier that used to sit
 * between exact overlap and constraint match -- one design's `creates`
 * intersecting another's `dependsOn`. Deleted rather than left in place
 * unused/undocumented: this repo is open source, so an unused mechanism
 * is visible in the source regardless of whether it's mentioned in any
 * customer-facing docs, and a docs page that undersells what the code
 * actually does is worse than not having the code. It also only ever
 * matched on an exact string in both designs' free-text `creates`/
 * `dependsOn` arrays -- the same brittleness as `triggers` (see
 * manifest.ts's note), just on a different field pair: catches "A creates
 * `packages/net/retry.ts`, B depends on `packages/net/retry.ts`" but
 * misses "A creates `RetryPolicy`, B depends on `Retrier`" (same idea,
 * different name). Kept for now: `exactOverlap` below (creates/touches
 * exact-match, the same brittleness, but a strictly more common phrasing
 * choice -- a file path is close to canonical even before it exists,
 * unlike a not-yet-decided symbol name).
 *
 * (2026-08-19, `exactOverlap` demoted from blocking to advisory-only -- a
 * same-file coincidence flags for display (design detail, activity feed)
 * but never demotes the design to `"flagged"` or denies the Edit/Write
 * gate. `constraintMatch` unchanged, still blocking.)
 *
 * (2026-08-26, tier 4 -- the Jaccard summary-similarity fallback -- removed
 * entirely, not just demoted. It only ever ran once tier 1 found *zero*
 * path-level overlap, on unvalidated bag-of-words similarity of free text
 * alone with no path corroboration, and by then was already redundant:
 * `"llm_divergence"` (the semantic comparator, `design-semantic-check.ts`)
 * is a strictly stronger signal for the same question -- an actual LLM
 * judgment over the designs' text, not a word-overlap heuristic -- and is
 * the bucket this kind of conceptual-overlap detection now belongs to
 * exclusively. `DesignSeverity`/`severity` is gone from the whole model as
 * of this same change: with tier 4 dropped and `DesignConstraintType`
 * collapsed to one value, whether a verdict blocks is now a pure, static
 * function of which verdict it is (`file_overlap` never does; the other
 * three always do), so a separately-varying severity field had nothing
 * left to vary.
 *
 * (2026-08-22, same-developer pairs excluded from tier 1 (and, historically,
 * the now-removed tier 4): a usability pass on twing-monitor found overlap/
 * conflict signal between a single developer's own two designs -- the
 * common case once one person runs several concurrent agents/sessions --
 * was pure noise in the activity feed, not just a false-positive-prone
 * blocker. Checked against this project's own live history: every
 * alignment thread this project has ever opened (14/14) was a self-pair,
 * and none was ever replied to or closed. `constraintMatch` (tier 3, see
 * structuralOverlaps and runDesignChecks below) is untouched -- it's a
 * path-vs-project-rule check with no "other developer" involved at all, so
 * there's nothing to exclude. Reversed from `design-divergence.ts`'s and
 * `checks.ts`'s prior convention of deliberately *including* a developer's
 * own concurrent sessions (§8) -- that convention is reversed there too,
 * same day, same reasoning. A dedicated same-developer-multi-agent-drift
 * feature is deferred, not rebuilt as a quieter variant of this one -- see
 * those files' own comments.)
 */

import { minimatch } from "minimatch";
import type { DesignStatement, DesignConstraint, DesignConflict, DesignVerdict, DesignConstraintType } from "@twing/core";

export interface DesignCheckOutcome {
  verdict: DesignVerdict;
  conflicts: DesignConflict[];
  /** Always present (mirrors `conflicts` above), not just on
   * `constraint_violation` -- empty everywhere else. See
   * matchConstraintsForPaths's doc comment for why this is a list now, not
   * a single optional hit. */
  constraints: ConstraintHit[];
}

/** ExitPlanMode retry dedup (design-store.ts's `openPlanModeDesignForSession`
 * / `reregisterFromPlan`, wired in app.ts's `POST /v1/designs/check`):
 * how similar an incoming `rawPlanText` needs to be to a candidate's stored
 * `rawPlanExcerpt` before being treated as "the same plan, retried" (update
 * in place) rather than a genuinely different plan that happens to share a
 * session id (register as a new row, leaving the candidate untouched).
 * Deliberately its own constant, not shared with anything in the
 * design-conflict model above -- a false positive here would silently
 * overwrite a different design's content, so a false match is a
 * correctness bug, not just a missed hint, and needs a different risk
 * calculus than any conflict-detection threshold.
 *
 * 0.7 -- tested empirically against real data rather than picked blind (see
 * the plan this shipped from): full, untruncated plan text on both sides
 * (`rawPlanExcerpt` stopped being 2000-char-truncated the same day this
 * shipped, precisely because it was distorting this comparison -- see
 * `DesignStatement.rawPlanExcerpt`'s doc comment). Unrelated plans scored
 * 0.03-0.14; a real plan substantively revised between two ExitPlanMode
 * retries (the realistic case -- a byte-identical retry is the easy case
 * any threshold catches) scored 0.815. 0.7 sits with comfortable headroom
 * on both sides: ~5x the unrelated ceiling, safely below the one real
 * revised-retry sample. A first guess of ~0.9 (before the truncation bug
 * was found and fixed) would have missed that same revised-retry case
 * entirely. Treat as a starting point -- the route logs the actual score on
 * every check so this can be recalibrated from real traffic, not just this
 * small sample. */
export const PLAN_RETRY_SIMILARITY_THRESHOLD = 0.7;

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

/** Composite key for `DesignStatement.justifiedOverlaps` (2026-08-18) --
 * shared between `exactOverlap` (consuming it) and `app.ts`'s
 * `/v1/designs/:id/resolve` (producing it at justify-time), so
 * the key format only ever lives in one place. Keyed per specific
 * overlapping path, not per design pair -- see the field's own doc comment
 * (core/types.ts) for why a coarser pair-level waiver would be wrong. */
export function overlapWaiverKey(conflictingDesignId: string, path: string): string {
  return `${conflictingDesignId}::${normalize(path)}`;
}

function intersects(a: string[], b: string[]): string[] {
  const bSet = new Set(b.map(normalize));
  return a.filter((x) => bSet.has(normalize(x)));
}

/** Bare boolean creates/touches intersection, ignoring developerId and
 * waivers -- deliberately *not* routed through `exactOverlap`/
 * `structuralOverlaps` (2026-08-22): those now skip same-developer pairs
 * entirely, which is correct for the overlap/conflict verdict, but wrong
 * for `app.ts`'s stale-sibling nudge, which only ever compares designs
 * within the *same session* -- same developer by construction, so it needs
 * a real "do these scopes intersect" answer independent of that exclusion.
 * Without this, every same-session sibling pair would look "non-
 * overlapping" to the nudge regardless of whether their scopes actually
 * collide, which is a real (not just cosmetic) wrong message. */
export function pathsOverlap(a: DesignStatement, b: DesignStatement): boolean {
  return intersects(a.creates, b.creates).length > 0 || intersects(a.touches, b.touches).length > 0;
}

/** Whether the *other* side of an llm_divergence pair should also get
 * flagged, alongside the design that triggered the comparator check
 * (2026-08-27, both-sides blocking) -- mirrors symbol_conflict's existing
 * "whichever side(s) have an open design" rule, an unprincipled asymmetry
 * before this: both buckets are peer-vs-peer conflicts under the
 * four-bucket model's own "approval belongs to whoever's authority you'd
 * be overriding" principle, so there was no reason only one of the two
 * ever blocked both parties.
 *
 * Exported and pure so this decision is directly unit-testable without
 * exercising `runSemanticComparatorPass`'s real (network-dependent, Bedrock)
 * LLM call -- `app.ts` re-fetches `other` live before calling this, since
 * the comparator's `others` snapshot may be stale by the time an async pass
 * reaches it.
 *
 * Two guards: `other` must still be genuinely `"open"` (closed/dormant/
 * already-flagged-for-something-else designs aren't touched, same
 * "whichever have an open design" rule symbol_conflict already uses), and
 * `other` must not have already justified *this specific pairing* from
 * their own side (`justifiedConflicts` -- findOrCreate's reverse-direction
 * fix means the same thread is reused either way, so this is a real,
 * checkable waiver, not a guess). */
export function shouldFlagOtherSide(other: DesignStatement | undefined, currentId: string): boolean {
  return other?.status === "open" && !other.justifiedConflicts.includes(currentId);
}

/** Tightening alignment threads, item 3 (2026-08-27): has this one design
 * "settled" its own half of a specific conflict pairing, for the purpose of
 * deciding whether the alignment thread the two sides share can auto-close?
 * Per-side, not per-thread -- the caller (`maybeAutoCloseThread`, app.ts)
 * checks both sides of a thread and only closes it once *both* come back
 * true. Two independent ways to settle:
 *  - **closed**: `status === "closed"` -- whether that was a deliberate
 *    `twing design close` (item 2's new deny-message option) or the
 *    terminal side-effect of an admin *rejecting* a review
 *    (`DesignRegistry.decideReview` always closes on reject -- "the design
 *    closes, the developer registers a fresh one"). Either way there's
 *    nothing left to do on *this* design's row; a rejected pairing
 *    genuinely counts as settled for the thread even though it wasn't
 *    resolved in the developer's favor -- see
 *    `notifyAlignmentThreadsOfDecision`'s own note about not conflating
 *    "closed" with "resolved" in what gets *said*, which is a separate
 *    concern from whether the thread can stop tracking it.
 *  - **resolved**: `status !== "flagged"` (still-flagged is never settled,
 *    belt-and-suspenders alongside the justified-list check below) AND
 *    `counterpartDesignId` shows up in the justified-list for this
 *    `category` -- proof this *specific* pairing was actually addressed,
 *    not just that some unrelated flag on this design cleared. Only
 *    `DesignRegistry.decideReview`'s *approve* path ever appends to either
 *    justified list (see `justifiedConflicts`/`justifiedSymbolConflicts`,
 *    core/types.ts) -- a reject never does, so a rejected design can only
 *    ever settle via the closed branch above, never this one. That's the
 *    fix for the bug found while scoping this: a reject must not look like
 *    a resolution.
 *
 * `justifiedSymbolConflicts` is composite-keyed (`${conflictingDesignId}::
 * ${symbolId}`, `overlapWaiverKey`) rather than a bare design-id list like
 * `justifiedConflicts` -- checked here with a prefix match ("waived
 * *something* against this counterpart") rather than requiring every
 * symbolId the thread has ever accumulated to be individually present.
 * `decideReview` always waives a symbol_conflict review's *entire* current
 * `symbolIds` set in one shot (see `symbolConflictWaivers`'s own read-back
 * comment, app.ts), so in practice "waived at all" and "waived as of the
 * last justify" coincide -- this stays a light per-counterpart signal, not
 * a strict per-symbol audit. */
export function isDesignSideSettled(design: DesignStatement | undefined, counterpartDesignId: string, category: "llm_divergence" | "symbol_conflict"): boolean {
  if (!design) return false;
  if (design.status === "closed") return true;
  if (design.status === "flagged") return false;
  if (category === "llm_divergence") return design.justifiedConflicts.includes(counterpartDesignId);
  return design.justifiedSymbolConflicts.some((key) => key.startsWith(`${counterpartDesignId}::`));
}

/** Tightening alignment threads, item 4 (2026-08-27): the looser sibling of
 * `isDesignSideSettled` above, used for the *dormancy* decision rather than
 * the closing one -- "has this side gone quiet, one way or another" instead
 * of "has this side actually been dealt with". A design going merely
 * `"dormant"` (inactivity alone, `DesignRegistry.sweepExpired`) is
 * deliberately *not* enough to auto-close a thread (see
 * `isDesignSideSettled`'s own doc comment and `maybeAutoCloseThread`,
 * app.ts -- dormancy is reversible, closing shouldn't be a side-effect of
 * someone merely going idle), but it's exactly enough to justify demoting
 * an open thread to dormant alongside it: there's nothing productive left
 * to surface about a conversation where every party involved is either
 * done or not currently working on it. `maybeDormThread` (app.ts) requires
 * this to be true for *both* sides before demoting -- one side going
 * dormant while the other is still actively flagged/live must leave the
 * thread open. */
export function isDesignSideDormantOrSettled(design: DesignStatement | undefined, counterpartDesignId: string, category: "llm_divergence" | "symbol_conflict"): boolean {
  return design?.status === "dormant" || isDesignSideSettled(design, counterpartDesignId, category);
}

/** Drops any path in `paths` already waived (`justifiedOverlaps`) for this
 * specific `otherId` -- item 7's fix (2026-08-18): a path *not* in the list
 * still flags normally, so this only ever narrows an already-detected
 * overlap down to its unwaived remainder, never widens what counts as an
 * overlap in the first place. */
function withoutJustified(candidate: DesignStatement, otherId: string, paths: string[]): string[] {
  return paths.filter((p) => !candidate.justifiedOverlaps.includes(overlapWaiverKey(otherId, p)));
}

/** Tier 1: exact `creates`/`touches` intersection. */
function exactOverlap(candidate: DesignStatement, other: DesignStatement): DesignConflict | undefined {
  const createsHit = withoutJustified(candidate, other.id, intersects(candidate.creates, other.creates));
  const touchesHit = withoutJustified(candidate, other.id, intersects(candidate.touches, other.touches));
  if (createsHit.length === 0 && touchesHit.length === 0) return undefined;
  const hit = [...createsHit, ...touchesHit];
  return {
    conflictingDesignId: other.id,
    agentLabel: other.agentLabel,
    overlapKind: createsHit.length > 0 ? "creates" : "touches",
    overlapDetail: `both ${createsHit.length > 0 ? "create" : "touch"} ${hit.join(", ")}`,
    conflictingSummary: other.summary,
    overlapPaths: hit,
  };
}

export interface ConstraintHit {
  id: string;
  statement: string;
  type: DesignConstraintType;
}

/**
 * The ground-truth version of tier 3: checks bare paths/symbols against
 * constraint scope globs, independent of any DesignStatement. Extracted
 * (2026-08-11, after a live test showed a `review_required` rule on
 * `packages/server/**` never fired because the session's registered design
 * simply never mentioned that path) so the same matching logic can run
 * against the *actual* file a hook is about to edit -- not just whatever a
 * session's self-reported `creates`/`touches` claimed at registration time.
 * See §17.9.
 */
// 2026-08-26: `CONSTRAINT_TYPE_PRIORITY` (a three-way priority map so a
// `review_required` match always outranked `canonical_abstraction`/
// `domain_fact` when several constraints hit the same path) is gone --
// `DesignConstraintType` collapsed to a single value the same day, so
// there's no longer more than one type to rank. Sort by scope-specificity
// alone now (see matchConstraintsForPaths below); every matching constraint
// is returned regardless of order (2026-08-22), so this only ever affects
// display order among simultaneous hits, never which are included.

/**
 * Returns *every* distinct constraint (deduped by id) that matches at least
 * one of `targets`, not just one "best" hit -- fixed 2026-08-22 (design-gate
 * friction item 8, found live shipping the constraint-deletion work
 * 2026-08-20): this used to collapse to a single winner by
 * constraint-type priority then scope specificity, so a candidate whose
 * paths violated two *different* constraints only ever saw the
 * higher-priority one -- justify-and-approve that one, retry, and only then
 * discover the second. Every consumer (runDesignChecks, `/v1/designs/check`
 * and friends, the Go hook's deny message, the CLI's printed output) now
 * threads a list through instead of a single optional hit. See design doc
 * §17.11.
 *
 * Sorted by scope-specificity alone (2026-08-26 -- was also ranked by
 * constraint-type priority before `DesignConstraintType` collapsed to one
 * value) -- most-specific first, so a caller that only wants "the one that
 * matters most" can still just take `[0]` (e.g. design-eval.test.ts's eval
 * cases, which only ever expect one constraint per case).
 *
 * Deliberate behavior change from the old single-hit version: two
 * *same-type* constraints both matching the same path (e.g. a broad
 * `packages/**` rule and a narrower `packages/server/**` rule of the same
 * type) used to suppress the broader one via the specificity tie-break --
 * that tie-break existed only to pick a single winner, which this function
 * no longer needs to do, so both now come back. Two constraints with
 * genuinely different statement text are real information for whoever's
 * reading the deny message, not noise to collapse away.
 */
export function matchConstraintsForPaths(
  targets: string[],
  constraints: DesignConstraint[],
  excludeConstraintIds: string[] = [],
): ConstraintHit[] {
  const excluded = new Set(excludeConstraintIds);
  const hits: { constraint: DesignConstraint; scopeLength: number }[] = [];

  for (const constraint of constraints) {
    if (excluded.has(constraint.id)) continue;
    let bestScopeLength: number | undefined;
    for (const scopePattern of constraint.scope) {
      if (!targets.some((t) => t === scopePattern || minimatch(t, scopePattern))) continue;
      if (bestScopeLength === undefined || scopePattern.length > bestScopeLength) {
        bestScopeLength = scopePattern.length;
      }
    }
    if (bestScopeLength !== undefined) {
      hits.push({ constraint, scopeLength: bestScopeLength });
    }
  }

  hits.sort((a, b) => b.scopeLength - a.scopeLength);

  return hits.map((h) => ({ id: h.constraint.id, statement: h.constraint.statement, type: h.constraint.type }));
}

/** Tier 3: `creates`/`touches` against every constraint's scope globs. */
function constraintMatch(candidate: DesignStatement, constraints: DesignConstraint[]): ConstraintHit[] {
  return matchConstraintsForPaths([...candidate.creates, ...candidate.touches], constraints, candidate.justifiedConstraintIds);
}

function keywordSet(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
}

/** Word-overlap similarity, 0-1, over unique lowercased keywords (length >
 * 2, so short stopwords like "a"/"in"/"is" fall out but common ones like
 * "the"/"and" don't -- doesn't materially inflate scores for unrelated
 * English text in practice, see `PLAN_RETRY_SIMILARITY_THRESHOLD`'s empirical
 * notes). Exported for reuse by the ExitPlanMode retry-dedup check
 * (design-store.ts / app.ts) -- its only consumer now that tier 4
 * (`summarySimilarity`) has been removed (2026-08-26). */
export function jaccard(a: string, b: string): number {
  const setA = keywordSet(a);
  const setB = keywordSet(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersectionSize = 0;
  for (const w of setA) if (setB.has(w)) intersectionSize++;
  const unionSize = new Set([...setA, ...setB]).size;
  return intersectionSize / unionSize;
}

/**
 * §17 scope enforcement's ground-truth backstop for a design's *own* claim
 * (as opposed to `matchConstraintsForPaths`, which checks a path against the
 * project's constraint scopes): is this literal file actually declared by
 * the design that's supposedly covering it? Same minimatch-based match as
 * `matchConstraintsForPaths`'s inner loop, just a plain boolean -- there's
 * no cross-constraint priority to resolve here, only "declared or not".
 * `creates` is included alongside `touches` since a design's own overlap
 * check (`exactOverlap` above) already treats the two as one combined scope
 * for matching purposes.
 */
export function pathInDesignScope(path: string, design: DesignStatement): boolean {
  const declared = [...design.creates, ...design.touches];
  return declared.some((p) => p === path || minimatch(path, p));
}

/**
 * Dedup union of a design's current creates/touches/dependsOn with a
 * proposed addition -- the one merge implementation shared by `/v1/designs/
 * :id/amend`'s pre-persist conflict check (which needs the *candidate*
 * merged shape to run `runDesignChecks` against) and `DesignRegistry.amend`
 * (which needs the same merge to persist), so the two can't drift apart.
 */
export function mergeDesignScope(
  design: DesignStatement,
  delta: { touches?: string[]; creates?: string[]; dependsOn?: string[] },
): { touches: string[]; creates: string[]; dependsOn: string[] } {
  return {
    touches: [...new Set([...design.touches, ...(delta.touches ?? [])])],
    creates: [...new Set([...design.creates, ...(delta.creates ?? [])])],
    dependsOn: [...new Set([...design.dependsOn, ...(delta.dependsOn ?? [])])],
  };
}

/**
 * Appends an amendment's summary as a dated `Update:` entry rather than
 * replacing the original outright (reversed 2026-08-18 -- the original
 * replace-not-merge design meant *any* summary amend, including one that
 * only meant to explain a scope-only delta like "also touches X because Y",
 * silently destroyed the design's entire original context: what a human
 * reviewer sees, what design-checks.ts's Jaccard summary-similarity tier
 * compares against, and (once `planTextFor` below stopped preferring a
 * stale `rawPlanExcerpt` snapshot over it) what the semantic comparator
 * reasons over. Free text still has no sensible word-level "union" the way
 * touches/creates/dependsOn do -- this doesn't attempt one, it just never
 * throws the old text away. `app.ts`'s amend route calls this exactly once,
 * before either the pre-persist check or the actual persist see the
 * result, so both act on the identical final string -- computing it twice
 * (once per call site) would risk each getting a different embedded date,
 * the same "checked one thing, persisted another" shape as the constraintId
 * attribution bug found earlier this session.
 */
export function appendSummaryUpdate(existingSummary: string, update: string): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD -- sortable, no sub-day precision needed for an amend log
  return `${existingSummary}\n\nUpdate (${date}): ${update}`;
}

/** Tier 1 (exact overlap) -- exported (2026-08-18) so
 * `/v1/designs/:id/resolve` can recompute the *current* set of structural
 * conflicts independently at justify-time, the same "trust current state,
 * not the original verdict" reasoning `constraintId`'s own recompute
 * already established, needed to know which specific paths a
 * justified-divergence review should waive (see
 * DesignStatement.justifiedOverlaps).
 *
 * Skips same-developer pairs (2026-08-22) -- see runDesignChecks's doc
 * comment for why. Both call sites (here via runDesignChecks, and
 * `/v1/designs/:id/resolve`'s own direct call) get the exclusion for free
 * by living here rather than at each call site. */
export function structuralOverlaps(candidate: DesignStatement, others: DesignStatement[]): DesignConflict[] {
  const conflicts: DesignConflict[] = [];
  for (const other of others) {
    if (other.id === candidate.id) continue;
    if (other.developerId === candidate.developerId) continue;
    const exact = exactOverlap(candidate, other);
    if (exact) conflicts.push(exact);
  }
  return conflicts;
}

export function runDesignChecks(
  candidate: DesignStatement,
  openDesigns: DesignStatement[],
  constraints: DesignConstraint[],
): DesignCheckOutcome {
  const others = openDesigns.filter((d) => d.id !== candidate.id);

  const structuralConflicts = structuralOverlaps(candidate, others);
  if (structuralConflicts.length > 0) {
    // Always advisory (2026-08-19, renamed from "overlap" 2026-08-26) -- a
    // same-file coincidence between two designs' self-reported
    // creates/touches isn't itself evidence of a real merge conflict (a
    // design can decline to actually write to a path it named, or write
    // something that doesn't collide with what the other one wrote). Still
    // worth surfacing before either writes code -- that's the one thing
    // this tier can do that claims (§4) can't, since claims don't exist
    // until code does -- just never worth blocking on. Real edits landing
    // on the same real symbol is a different, blocking bucket --
    // `"symbol_conflict"`, see checks.ts/design-divergence.ts.
    return { verdict: "file_overlap", conflicts: structuralConflicts, constraints: [] };
  }

  // §17 review-flow fix (2026-08): a constraint already justified and
  // approved *for this exact design* doesn't re-flag -- runDesignChecks
  // re-evaluates the whole merged scope on every amend/resume, not just the
  // new delta, so without this a design would re-trip the same
  // already-settled constraint forever. A *different* constraint id still
  // flags normally; this waives those specific matches, not "skip all
  // checks." (2026-08-22: `constraintHits` is now every match, not one --
  // see matchConstraintsForPaths's doc comment.)
  const constraintHits = constraintMatch(candidate, constraints);
  if (constraintHits.length > 0) {
    return { verdict: "constraint_violation", conflicts: [], constraints: constraintHits };
  }

  return { verdict: "clean", conflicts: [], constraints: [] };
}
