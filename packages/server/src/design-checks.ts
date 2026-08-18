/**
 * Overlap detection (design doc §17.4 / spec §6) -- cheapest, highest-
 * precision first: exact overlap, then dependency collision, then
 * constraint match, then a Jaccard summary-similarity fallback that only
 * runs if the first three found nothing.
 */

import { minimatch } from "minimatch";
import type { DesignStatement, DesignConstraint, DesignConflict, DesignVerdict, DesignConstraintType } from "@twing/core";

export interface DesignCheckOutcome {
  verdict: DesignVerdict;
  conflicts: DesignConflict[];
  constraint?: ConstraintHit;
}

const SUMMARY_SIMILARITY_THRESHOLD = 0.5;

/** ExitPlanMode retry dedup (design-store.ts's `openPlanModeDesignForSession`
 * / `reregisterFromPlan`, wired in app.ts's `POST /v1/designs/check`):
 * how similar an incoming `rawPlanText` needs to be to a candidate's stored
 * `rawPlanExcerpt` before being treated as "the same plan, retried" (update
 * in place) rather than a genuinely different plan that happens to share a
 * session id (register as a new row, leaving the candidate untouched).
 * Deliberately a separate, independent constant from
 * `SUMMARY_SIMILARITY_THRESHOLD` above, not a reuse of it -- that one gates
 * a low-stakes advisory flag for a human to look at; a false positive here
 * would silently overwrite a different design's content, so a false match
 * is a correctness bug, not just a missed hint, and needs a different risk
 * calculus.
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

function intersects(a: string[], b: string[]): string[] {
  const bSet = new Set(b.map(normalize));
  return a.filter((x) => bSet.has(normalize(x)));
}

/** Tier 1: exact `creates`/`touches` intersection. */
function exactOverlap(candidate: DesignStatement, other: DesignStatement): DesignConflict | undefined {
  const createsHit = intersects(candidate.creates, other.creates);
  const touchesHit = intersects(candidate.touches, other.touches);
  if (createsHit.length === 0 && touchesHit.length === 0) return undefined;
  const hit = [...createsHit, ...touchesHit];
  return {
    conflictingDesignId: other.id,
    agentLabel: other.agentLabel,
    overlapKind: createsHit.length > 0 ? "creates" : "touches",
    overlapDetail: `both ${createsHit.length > 0 ? "create" : "touch"} ${hit.join(", ")}`,
    conflictingSummary: other.summary,
  };
}

/** Tier 2: one design creates what the other assumes already exists (either
 * direction) -- catches "two agents each build their own retry helper" even
 * when file paths never literally collide. */
function dependencyCollision(candidate: DesignStatement, other: DesignStatement): DesignConflict | undefined {
  const candidateBuildsWhatOtherAssumes = intersects(candidate.creates, other.dependsOn);
  const otherBuildsWhatCandidateAssumes = intersects(other.creates, candidate.dependsOn);
  const hit = [...candidateBuildsWhatOtherAssumes, ...otherBuildsWhatCandidateAssumes];
  if (hit.length === 0) return undefined;
  return {
    conflictingDesignId: other.id,
    agentLabel: other.agentLabel,
    overlapKind: "depends_on",
    overlapDetail: `one design creates what the other depends on: ${hit.join(", ")}`,
    conflictingSummary: other.summary,
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
// When several constraints match the same path, `review_required` outranks
// `canonical_abstraction`/`domain_fact` regardless of scope width (a
// sign-off requirement shouldn't get silently masked by a broader
// duplicate-abstraction rule seeded earlier -- found live, 2026-08-11:
// packages/server/** correctly matched, but the earlier, broader
// packages/** "don't invent a second wire format" rule won the race and
// reported instead, which is a misleading reason even though the deny
// itself was still correct).
const CONSTRAINT_TYPE_PRIORITY: Record<DesignConstraintType, number> = {
  review_required: 0,
  canonical_abstraction: 1,
  domain_fact: 2,
};

export function matchConstraintsForPaths(
  targets: string[],
  constraints: DesignConstraint[],
  excludeConstraintIds: string[] = [],
): ConstraintHit | undefined {
  // §17 review-flow fix (2026-08): excludeConstraintIds must be filtered
  // *inside* the best-match selection, not applied as a post-hoc check on
  // whatever single constraint wins -- this function only ever returns one
  // "best" hit. Found live via this fix's own test: filtering after the
  // fact meant an already-justified constraint winning the selection could
  // silently hide a second, genuinely different, never-justified
  // constraint that also matched something in scope. Skipping excluded
  // ids up front lets the *next*-best real match win instead.
  const excluded = new Set(excludeConstraintIds);
  let best: { constraint: DesignConstraint; scopeLength: number } | undefined;

  for (const constraint of constraints) {
    if (excluded.has(constraint.id)) continue;
    for (const scopePattern of constraint.scope) {
      if (!targets.some((t) => t === scopePattern || minimatch(t, scopePattern))) continue;

      const isHigherPriority = !best || CONSTRAINT_TYPE_PRIORITY[constraint.type] < CONSTRAINT_TYPE_PRIORITY[best.constraint.type];
      const isMoreSpecificTie =
        best && CONSTRAINT_TYPE_PRIORITY[constraint.type] === CONSTRAINT_TYPE_PRIORITY[best.constraint.type] && scopePattern.length > best.scopeLength;
      if (isHigherPriority || isMoreSpecificTie) {
        best = { constraint, scopeLength: scopePattern.length };
      }
      break; // this constraint already matched -- no need to check its other scope patterns
    }
  }

  return best ? { id: best.constraint.id, statement: best.constraint.statement, type: best.constraint.type } : undefined;
}

/** Tier 3: `creates`/`touches` against a constraint's scope globs. */
function constraintMatch(candidate: DesignStatement, constraints: DesignConstraint[]): ConstraintHit | undefined {
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
 * (design-store.ts / app.ts) as well as `summarySimilarity` below. */
export function jaccard(a: string, b: string): number {
  const setA = keywordSet(a);
  const setB = keywordSet(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersectionSize = 0;
  for (const w of setA) if (setB.has(w)) intersectionSize++;
  const unionSize = new Set([...setA, ...setB]).size;
  return intersectionSize / unionSize;
}

/** Tier 4: deliberately weak fallback net, only consulted when 1-3 find
 * nothing (design doc §17.4 / spec §6.4). */
function summarySimilarity(candidate: DesignStatement, other: DesignStatement): DesignConflict | undefined {
  const score = jaccard(candidate.summary, other.summary);
  if (score < SUMMARY_SIMILARITY_THRESHOLD) return undefined;
  return {
    conflictingDesignId: other.id,
    agentLabel: other.agentLabel,
    overlapKind: "touches",
    overlapDetail: `summaries are ${Math.round(score * 100)}% similar by keyword overlap (fallback signal, low confidence)`,
    conflictingSummary: other.summary,
  };
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

export function runDesignChecks(
  candidate: DesignStatement,
  openDesigns: DesignStatement[],
  constraints: DesignConstraint[],
): DesignCheckOutcome {
  const others = openDesigns.filter((d) => d.id !== candidate.id);

  const structuralConflicts: DesignConflict[] = [];
  for (const other of others) {
    const exact = exactOverlap(candidate, other);
    if (exact) {
      structuralConflicts.push(exact);
      continue;
    }
    const dep = dependencyCollision(candidate, other);
    if (dep) structuralConflicts.push(dep);
  }
  if (structuralConflicts.length > 0) {
    return { verdict: "overlap", conflicts: structuralConflicts };
  }

  // §17 review-flow fix (2026-08): a constraint already justified and
  // approved *for this exact design* doesn't re-flag -- runDesignChecks
  // re-evaluates the whole merged scope on every amend/resume, not just the
  // new delta, so without this a design would re-trip the same
  // already-settled constraint forever. A *different* constraint id still
  // flags normally; this waives one specific match, not "skip all checks."
  const constraintHit = constraintMatch(candidate, constraints);
  if (constraintHit) {
    return { verdict: "constraint_flag", conflicts: [], constraint: constraintHit };
  }

  const similarityConflicts: DesignConflict[] = [];
  for (const other of others) {
    const sim = summarySimilarity(candidate, other);
    if (sim) similarityConflicts.push(sim);
  }
  if (similarityConflicts.length > 0) {
    return { verdict: "overlap", conflicts: similarityConflicts };
  }

  return { verdict: "clean", conflicts: [] };
}
