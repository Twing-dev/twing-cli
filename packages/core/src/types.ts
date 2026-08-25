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
  /** "soft" (Read/Grep/Glob) is still a valid value on the wire and in
   * storage, but as of 2026-08-22 the daemon (the only live producer)
   * never constructs one — see `daemon/claims.ts`'s `extractClaim` and
   * `protocol.ts`'s `stageForTool`. Kept as a real value here rather than
   * narrowed to `"firm"` only, since nothing prevents a future producer
   * from legitimately emitting one again. */
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
  /** §17 design linking (2026-08): cross-project label -- self-assigned to
   * this design's own `id` by `DesignRegistry.register()` when the caller
   * doesn't supply one, so every design has a non-null groupId ("group of
   * one" by default). A sibling registration for the *same* unit of work
   * in a different project passes this design's `id` back in as its own
   * `groupId` to link the two rows. Linking is purely a label -- there is
   * no new table, no cross-project overlap/constraint/scope-match
   * comparison, and no new access-control surface; `openDesigns`/
   * `reviewDecision`/`justifiedConstraintIds` etc. all stay strictly
   * single-`projectId`, unaffected by grouping.
   *
   * Only two fields propagate across every row sharing a `groupId` (any
   * project): `summary` (`DesignRegistry.amend()`) and closing
   * (`DesignRegistry.close()`) -- the two things meant to read as "one
   * shared thing" across the group; letting them silently drift would make
   * the link actively misleading rather than merely incomplete.
   * `creates`/`touches`/`dependsOn` never propagate (inherently
   * per-project data -- repo A's paths are never repo B's), and neither
   * does `reviewDecision`/constraint justification (a constraint hit in
   * one project is that project's own admin's call, regardless of what
   * it's grouped with). See `DesignRegistry.register`/`amend`/`close` in
   * `packages/server/src/design-store.ts` for the mechanics, and
   * `hook/design_gate.go`'s `handleExitPlanModeMultiCandidate` for where a
   * multi-repo plan gets one minted and linked automatically. */
  groupId?: string;
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
   * carrying `constraintIds` is approved -- one review can settle several at
   * once (2026-08-22); consulted by `runDesignChecks` to skip constraint
   * matches already settled for this exact design. A *new*, different
   * review_required match still flags normally -- this waives specific
   * constraints, not "never check constraints again." */
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
  /** Semantic comparator's counterpart to `justifiedOverlaps` above
   * (2026-08-22) -- entries are bare `conflictingDesignId`s (no paths: a
   * `"conflict"` verdict has no path evidence to key on, see
   * DesignVerdict's doc comment), so `runSemanticComparatorPass` skips
   * re-checking (and re-flagging) a pair once its conflict has been
   * justified and approved. Appended (never removed) by
   * `DesignRegistry.decideReview` when a review carrying
   * `conflictWaivers` is approved -- see `PendingReview.conflictWaivers`. */
  justifiedConflicts: string[];
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

/** `"conflict"` (2026-08-22): the semantic comparator's own verdict
 * (design-semantic-check.ts's `checkSemanticConflict`, driven by app.ts's
 * `runSemanticComparatorPass`) -- an LLM judgment that two designs conflict
 * in intent, as opposed to `"overlap"`'s exact-path/keyword matching.
 * Distinct from `"overlap"` because it has different evidence (LLM
 * reasoning over free text, not paths) and a different justification shape
 * (see DesignStatement.justifiedConflicts / PendingReview.conflictWaivers,
 * keyed by conflicting design id alone, no paths -- there's nothing
 * path-shaped to waive). Never returned by `runDesignChecks`/
 * `DesignCheckResult` (design-checks.ts's tiers 1-4 run synchronously
 * against the request that triggered them); only ever set via
 * `DesignRegistry.flag()` from the async comparator pass, after its
 * response has already been sent. */
export type DesignVerdict = "clean" | "overlap" | "constraint_flag" | "conflict";

/** 2026-08-19: an `overlap`/`constraint_flag` verdict is no longer
 * uniformly blocking -- `severity` says which of the two it is. `"warning"`
 * is display-only: the conflict is recorded (activity feed, design detail)
 * but the design stays `"open"` and no gate denies anything. `"error"` is
 * today's original behavior, unchanged: the design gets demoted to
 * `"flagged"` (design-store.ts's `flag()`), which is what the Edit/Write
 * gate's `/v1/designs/scope-match` and ExitPlanMode's registration-time
 * check both key off to deny. As of 2026-08-22, both `exactOverlap` (tier 1)
 * and `summarySimilarity` (tier 4) are `"warning"` -- only `constraintMatch`
 * (tier 3) stays `"error"` among the synchronous tiers. Absent/undefined on
 * a `"clean"` verdict, where severity is moot. `"conflict"` verdicts don't
 * carry a `DesignSeverity` at all -- they're set directly via `flag()` from
 * the async comparator pass, never through `DesignCheckResult`. */
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
  /** Every constraint the checked scope matched (2026-08-22 -- was a single
   * `constraint` object; `matchConstraintsForPaths` used to collapse to one
   * "best" hit even when several different constraints each matched a
   * different target path, so a session justifying the one it saw would
   * only discover the next one on retry. See design-checks.ts's own doc
   * comment on `matchConstraintsForPaths` for the full reasoning. */
  constraints?: { id: string; statement: string; type: DesignConstraintType }[];
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
   * Recorded so an approval can be attributed to the *specific* constraints
   * it settled -- see DesignStatement.justifiedConstraintIds. Plural
   * (2026-08-22, was a single `constraintId`) for the same reason
   * `DesignCheckResult.constraints` is now a list -- one justified
   * divergence can settle several distinct constraint matches at once
   * rather than needing a separate review per constraint. Same
   * list-of-things-one-review-can-settle shape as `overlapWaivers` below,
   * which made the identical move for structural overlaps in 2026-08-18. */
  constraintIds?: string[];
  /** Set only when this design currently has real structural overlap(s)
   * against other open designs at justify-time (2026-08-18) -- independent
   * of `constraintIds`, a review can carry both at once. Recomputed fresh by
   * `/v1/designs/:id/resolve` against the design's *current* scope (same
   * "trust current state, not the original verdict" reasoning that
   * `constraintId`'s own recompute already established), not trusted from
   * whatever verdict originally flagged this design. One entry per
   * conflicting design, each naming the specific paths that overlap it --
   * see DesignStatement.justifiedOverlaps for how an approval consumes
   * this. */
  overlapWaivers?: { conflictingDesignId: string; paths: string[] }[];
  /** Semantic comparator's counterpart to `overlapWaivers` above
   * (2026-08-22) -- set only when this design currently has a `"conflict"`
   * flag against it (recorded conflicts, not recomputed live at
   * justify-time: unlike `overlapWaivers`'s cheap local recompute, a live
   * recheck here would mean a second synchronous LLM call inside
   * `/v1/designs/:id/resolve`). One entry per conflicting design, no paths
   * -- see DesignStatement.justifiedConflicts for how an approval consumes
   * this. */
  conflictWaivers?: { conflictingDesignId: string }[];
}
