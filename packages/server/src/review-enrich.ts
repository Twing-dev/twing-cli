/**
 * Turns a bare `PendingReview` into the shape a human can actually decide
 * on (2026-08-25).
 *
 * The problem this solves: `listReviews` returns review rows verbatim, so
 * `GET /v1/reviews` carried the requester's `justification` and a handful
 * of opaque ids -- and nothing about the work itself. twing-monitor's
 * review card therefore led with the justification, which meant an admin
 * was shown the argument for letting something through without being shown
 * what it was, who wanted it, or what had stopped it. The question a
 * reviewer is really being asked is "do I want this to happen?", and the
 * response didn't contain enough to answer it.
 *
 * Deliberately a pure function over injected lookups rather than a method
 * on `DesignRegistry`: the enrichment spans the design registry *and* the
 * constraint store, and making either own it would couple two stores that
 * are otherwise independent. Same reasoning as `design-checks.ts` staying
 * pure -- it makes this trivially testable with plain maps, no db.
 *
 * Every added field is optional. A review whose design has since been
 * deleted enriches to the same object minus `design`, rather than throwing:
 * a stale row must never be able to take down the whole listing.
 */

import type {
  PendingReview,
  EnrichedPendingReview,
  ReviewConflictSummary,
  DesignStatement,
  DesignConstraint,
} from "@twing/core";

export type DesignLookup = (id: string) => DesignStatement | undefined;
export type ConstraintLookup = (id: string) => DesignConstraint | undefined;

/** `overlapWaivers`, `conflictWaivers`, and (2026-08-26) `symbolConflictWaivers`
 * all answer the same human question -- "whose work does this collide
 * with?" -- so they're merged into one list, `kind` preserving which check
 * produced each (`"overlap"`/`"conflict"` are this field's own waiver-kind
 * labels, not `DesignVerdict` values -- `"conflict"` here means what's now
 * called the `llm_divergence` bucket; left unrenamed to keep this field's
 * diff bounded, see `ReviewConflictSummary`'s doc comment in core/types.ts).
 * Order is stable: overlaps, then semantic conflicts, then symbol
 * conflicts, each in the order recorded. */
function collectConflicts(review: PendingReview, lookupDesign: DesignLookup): ReviewConflictSummary[] {
  const out: ReviewConflictSummary[] = [];

  for (const waiver of review.overlapWaivers ?? []) {
    const other = lookupDesign(waiver.conflictingDesignId);
    out.push({
      designId: waiver.conflictingDesignId,
      kind: "overlap",
      ...(other ? { summary: other.summary, developerId: other.developerId } : {}),
      ...(waiver.paths.length > 0 ? { paths: waiver.paths } : {}),
    });
  }

  for (const waiver of review.conflictWaivers ?? []) {
    const other = lookupDesign(waiver.conflictingDesignId);
    out.push({
      designId: waiver.conflictingDesignId,
      kind: "conflict",
      ...(other ? { summary: other.summary, developerId: other.developerId } : {}),
    });
  }

  for (const waiver of review.symbolConflictWaivers ?? []) {
    const other = lookupDesign(waiver.conflictingDesignId);
    out.push({
      designId: waiver.conflictingDesignId,
      kind: "symbol_conflict",
      ...(other ? { summary: other.summary, developerId: other.developerId } : {}),
      ...(waiver.symbolIds.length > 0 ? { paths: waiver.symbolIds } : {}),
    });
  }

  return out;
}

export function enrichReview(
  review: PendingReview,
  lookupDesign: DesignLookup,
  lookupConstraint: ConstraintLookup,
): EnrichedPendingReview {
  const design = lookupDesign(review.designId);

  // A constraint removed since the review was raised (`twing constraints
  // remove` is unilateral and immediate) leaves an id that resolves to
  // nothing. Dropping it silently is right: the rule genuinely no longer
  // applies, and showing a bare id would be worse than showing nothing.
  const constraints = (review.constraintIds ?? [])
    .map(lookupConstraint)
    .filter((c): c is DesignConstraint => c !== undefined)
    .map((c) => ({ id: c.id, statement: c.statement, type: c.type }));

  const conflicts = collectConflicts(review, lookupDesign);

  return {
    ...review,
    ...(design
      ? {
          design: {
            summary: design.summary,
            creates: design.creates,
            touches: design.touches,
            developerId: design.developerId,
            status: design.status,
          },
        }
      : {}),
    ...(constraints.length > 0 ? { constraints } : {}),
    ...(conflicts.length > 0 ? { conflicts } : {}),
  };
}

export function enrichReviews(
  reviews: PendingReview[],
  lookupDesign: DesignLookup,
  lookupConstraint: ConstraintLookup,
): EnrichedPendingReview[] {
  return reviews.map((r) => enrichReview(r, lookupDesign, lookupConstraint));
}
