/**
 * Claim/CallEdge/Notice data model, per design doc §11. Signatures are
 * type/name-level, never implementation bodies — see the payload boundary
 * note in §11 and §4a of the memo.
 */

/** Shared by the daemon's hook-driven extraction and the CLI's git-diff
 * fallback, so a claim's lifetime doesn't depend on which path produced it. */
export const DEFAULT_CLAIM_TTL_MS = 6 * 60 * 60 * 1000;

export interface Claim {
  projectId: string;
  developerId: string;
  sessionId: string;
  branch: string;
  /** "src/net/retry.ts::RetryPolicy.backoff" — see computeSymbolId in symbol-id.ts */
  symbolId: string;
  kind: "read" | "write";
  stage: "soft" | "firm";
  signatureChanged?: boolean;
  oldSignature?: string;
  newSignature?: string;
  constraintIds?: string[];
  ts: number;
  /** Default 6h, refreshed on session activity. */
  ttlMs: number;
}

export interface CallEdge {
  projectId: string;
  callerSymbolId: string;
  calleeSymbolId: string;
}

export interface Notice {
  message: string;
  /** Mirrors Finding.threadId when this notice was generated from a
   * design_divergence finding -- lets the delivered text point straight at
   * `twing align respond --finding <id>` without a second round trip. */
  threadId?: string;
}

/**
 * §12's v0 divergence checks. Structured — unlike Notice, which is already
 * reduced to a flat message string for the hook's additionalContext — so
 * `align`/`review` (§6) can print "the symbol, the other party
 * involved, and why it was flagged" from a POST /v1/claims response (§7).
 */
export type FindingKind = "textual_overlap" | "contract_divergence" | "design_divergence" | "design_semantic_conflict";

export interface Finding {
  kind: FindingKind;
  projectId: string;
  symbolId: string;
  /** The developer this finding is reported to / was surfaced via. */
  developerId: string;
  /** The other party in the divergence. */
  otherDeveloperId: string;
  reason: string;
  ts: number;
  /** Set only for `design_divergence` findings -- the alignment thread this
   * finding opened/reused, for replying via `twing align respond`. Optional
   * so every existing Finding producer/consumer (including `hook/**`, which
   * never touches this shape) stays unaffected. */
  threadId?: string;
}

/**
 * Design-conflict coordinator (design doc §17, merged from
 * docs/design-conflict-coordinator-spec.md). A distinct code path from
 * Claim/Finding above — this is the one part of the system that blocks.
 */

/** How long an `open`/`flagged` design can go with no real activity before
 * `DesignRegistry.sweepExpired()` demotes it to `"dormant"` (§17 design
 * lifecycle, 2026-08) -- re-based off `lastActivityAt`, not `createdAt`,
 * so genuinely active work never dies just for being old. Set higher than
 * a first instinct would suggest: it's a backstop for silent abandonment,
 * not the primary staleness signal -- see `app.ts`'s registration-time
 * stale-sibling notice for the fast/precise "session visibly moved on"
 * case, which fires immediately instead of waiting out any inactivity
 * window. A starting knob, not a load-bearing constant (same spirit as
 * `DEFAULT_CLAIM_TTL_MS` above never having needed elaborate justification).
 * Named `DEFAULT_DESIGN_TTL_MS` prior to the lifecycle work. */
export const DEFAULT_DESIGN_ACTIVE_TTL_MS = 12 * 60 * 60 * 1000;

/** How long a `dormant` design can sit with no activity before it's
 * terminally `"expired"` -- server-wide only, no per-design override (§17
 * design lifecycle, 2026-08). Generous on purpose: dormant designs are
 * cheap (excluded from `openDesigns()`'s pairwise-comparison set) and
 * fully resumable via `DesignRegistry.resume()`, so there's little cost to
 * giving a paused project a real chance to come back. */
export const DEFAULT_DESIGN_DORMANT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface DesignStatement {
  id: string;
  projectId: string;
  developerId: string;
  sessionId: string;
  agentLabel?: string;
  /** "flagged" (2026-08, §17 scope enforcement): the design's own
   * registration/amendment verdict wasn't `clean` -- it's addressable by id
   * (`resolve`/`amend` still work on it) but does NOT count as "this
   * session has a usable open design" for the Edit/Write gate. Never set
   * directly by `register`/`amend`; only `DesignRegistry.flag()` sets it.
   *
   * "dormant" (2026-08, §17 design lifecycle): no real activity for
   * `ttlMs` -- excluded from `openDesigns()` (the actual fix for
   * unbounded O(n²) pairwise comparison growth), but still fully
   * addressable (`resolve`/`amend`/`resume` all still work on it) and
   * never silently woken -- only `DesignRegistry.resume()` transitions it
   * back to `"open"`, and that always re-runs the full conflict check
   * first. */
  status: "open" | "flagged" | "dormant" | "superseded" | "closed" | "expired";
  createdAt: number;
  closedAt?: number;
  summary: string;
  creates: string[];
  touches: string[];
  dependsOn: string[];
  /** The full `rawPlanText` an `ExitPlanMode` registration sent (§17.2),
   * verbatim -- despite the name, no longer truncated (was capped at 2000
   * chars via app.ts's `RAW_PLAN_EXCERPT_CHARS` until that cap was dropped,
   * 2026-08-18: it was silently truncating both the semantic comparator's
   * input, design-semantic-check.ts's `planTextFor`, and the ExitPlanMode
   * retry-dedup Jaccard check, design-checks.ts's
   * `PLAN_RETRY_SIMILARITY_THRESHOLD`, for any plan longer than 2000 chars
   * -- not worth keeping a `-Excerpt` name around for what's now the full
   * text, but renaming the field would touch every call site for no
   * behavioral gain). Never set on a structured `twing design register`
   * call (CLI always sends structured fields, never `rawPlanText`) -- this
   * is the one reliable signal a design row came from `ExitPlanMode`. */
  rawPlanExcerpt?: string;
  /** Active-inactivity threshold (§17 design lifecycle, 2026-08): how long
   * this design can go with no activity before going dormant. Refreshed on
   * activity, not counted from `createdAt` -- see `DesignRegistry.touch()`.
   * Named `ttlMs` from before the lifecycle work; kept rather than renamed
   * to avoid touching every call site, but it means "active TTL" now, not
   * "hard TTL from creation." */
  ttlMs: number;
  /** Set at registration to `createdAt`, refreshed by `DesignRegistry.touch()`
   * on a real in-scope edit and by `amend`/`resume` (§17 design lifecycle,
   * 2026-08) -- the basis `ttlMs`/`openDesigns()`/the dormancy sweep are all
   * computed from, instead of `createdAt`. */
  lastActivityAt: number;
  /** Bumped by `DesignRegistry.amend()` on every scope expansion -- lets the
   * async semantic-comparator loop (`app.ts`'s `runSemanticComparatorPass`)
   * cooperatively cancel a stale in-flight pass once a newer amendment has
   * superseded the scope it was comparing. */
  scopeVersion: number;
  /** Set once a justified-divergence review on this design is decided --
   * durable independent of later `status` changes (e.g. reopening on
   * approval), so it's a directly-queryable precedent fact for later
   * compounding rather than something only recoverable by joining
   * PendingReview. Undefined means no review was ever attached, or one is
   * still pending. */
  reviewDecision?: "approve" | "reject";
  /** Found live (2026-08): `runDesignChecks` re-evaluates a design's *entire*
   * merged scope on every amend/resume, not just the newly-added delta -- so
   * without this, a design that ever touched a `review_required` path would
   * re-trip that same already-approved constraint on every future amend,
   * forever, regardless of whether the new delta was even related. Appended
   * to (never removed from) by `DesignRegistry.decideReview` when a review
   * carrying a `constraintId` is approved; consulted by `runDesignChecks` to
   * skip a constraint match already settled for this exact design. A *new*,
   * different review_required match still flags normally -- this waives one
   * specific constraint, not "never check constraints again." */
  justifiedConstraintIds: string[];
  /** Structural design-vs-design overlap's counterpart to
   * `justifiedConstraintIds` above (2026-08-18) -- `exactOverlap`
   * (design-checks.ts) had no approval memory at all before this: an
   * already-justified-and-approved overlap between two designs re-flagged
   * identically on every retry, forever, even with zero
   * scope change (confirmed live validating the ExitPlanMode retry-dedup
   * fix). Entries are composite keys, `${conflictingDesignId}::${path}`
   * (`overlapWaiverKey` in design-checks.ts) -- deliberately keyed per
   * *specific overlapping path*, not per design pair: waiving one file's
   * collision must not silently swallow a different, later-added
   * overlapping file between the same two designs. Appended (never
   * removed) by `DesignRegistry.decideReview` when a review carrying
   * `overlapWaivers` is approved -- see `PendingReview.overlapWaivers`.
   * Deliberately one-directional: this design's owner choosing to proceed
   * despite another design's claim on a path says nothing about whether
   * the *other* design's own checks should waive that same path -- that's
   * a separate decision on that design's own row, if it ever comes up. */
  justifiedOverlaps: string[];
}

export type DesignConstraintType = "canonical_abstraction" | "domain_fact" | "review_required";

export interface DesignConstraint {
  id: string;
  projectId: string;
  type: DesignConstraintType;
  statement: string;
  /** Path globs or symbol names this applies to. */
  scope: string[];
  /** "seeded" | "ratified_from_divergence:<designId>" */
  source: string;
  createdAt: number;
}

export type DesignVerdict = "clean" | "overlap" | "constraint_flag";

/** 2026-08-19: an `overlap`/`constraint_flag` verdict is no longer
 * uniformly blocking -- `severity` says which of the two it is. `"warning"`
 * is display-only: the conflict is recorded (activity feed, design detail)
 * but the design stays `"open"` and no gate denies anything. `"error"` is
 * today's original behavior, unchanged: the design gets demoted to
 * `"flagged"` (design-store.ts's `flag()`), which is what the Edit/Write
 * gate's `/v1/designs/scope-match` and ExitPlanMode's registration-time
 * check both key off to deny. Currently `exactOverlap` (tier 1) is the only
 * `"warning"` source -- `summarySimilarity` (tier 4) and `constraintMatch`
 * (tier 3) both stay `"error"`. Absent/undefined on a `"clean"` verdict,
 * where severity is moot. */
export type DesignSeverity = "warning" | "error";

export type DesignOverlapKind = "creates" | "touches" | "constraint";

export interface DesignConflict {
  conflictingDesignId: string;
  agentLabel?: string;
  overlapKind: DesignOverlapKind;
  overlapDetail: string;
  conflictingSummary: string;
  /** The specific colliding path(s) `overlapDetail` describes in prose,
   * structured (2026-08-18) so a caller can act on them programmatically --
   * originally only ever rendered into the human-readable `overlapDetail`
   * string. Empty for `summarySimilarity`'s tier-4 fallback, which has no
   * specific path(s) to name. Used by `/v1/designs/:id/resolve`'s
   * overlap-waiver recompute (see `DesignStatement.justifiedOverlaps`) to
   * know exactly which paths a justified-divergence review should cover. */
  overlapPaths: string[];
}

export interface DesignCheckResult {
  verdict: DesignVerdict;
  designId: string;
  conflicts?: DesignConflict[];
  constraint?: { id: string; statement: string; type: DesignConstraintType };
  /** See DesignSeverity. Undefined for `"clean"`. */
  severity?: DesignSeverity;
}

export interface PendingReview {
  id: string;
  designId: string;
  projectId: string;
  justification: string;
  createdAt: number;
  decision?: "approve" | "reject";
  /** Set only when this review was created against a `constraint_flag`
   * verdict (undefined for an `overlap`-triggered justified_divergence).
   * Recorded so an approval can be attributed to the *specific* constraint
   * it settled -- see DesignStatement.justifiedConstraintIds. */
  constraintId?: string;
  /** Set only when this design currently has real structural overlap(s)
   * against other open designs at justify-time (2026-08-18) -- independent
   * of `constraintId`, a review can carry both at once. Recomputed fresh by
   * `/v1/designs/:id/resolve` against the design's *current* scope (same
   * "trust current state, not the original verdict" reasoning that
   * `constraintId`'s own recompute already established), not trusted from
   * whatever verdict originally flagged this design. One entry per
   * conflicting design, each naming the specific paths that overlap it --
   * see DesignStatement.justifiedOverlaps for how an approval consumes
   * this. */
  overlapWaivers?: { conflictingDesignId: string; paths: string[] }[];
}
