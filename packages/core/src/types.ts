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
   * (2026-08-22) -- entries are bare `conflictingDesignId`s (no paths: an
   * `"llm_divergence"` verdict has no path evidence to key on, see
   * DesignVerdict's doc comment), so `runSemanticComparatorPass` skips
   * re-checking (and re-flagging) a pair once its conflict has been
   * justified and approved. Appended (never removed) by
   * `DesignRegistry.decideReview` when a review carrying
   * `conflictWaivers` is approved -- see `PendingReview.conflictWaivers`. */
  justifiedConflicts: string[];
  /** `"symbol_conflict"`'s own approval memory (2026-08-26) -- same
   * composite-key shape as `justifiedOverlaps` (`${conflictingDesignId}::${symbolId}`,
   * via `overlapWaiverKey`), but kept as its own field rather than folded
   * into `justifiedOverlaps`: a `file_overlap` warning (row 2, always
   * advisory, self-reported scope) and a `symbol_conflict` block (row 3,
   * always blocking, real edits) are philosophically different waivers
   * even though the key shape coincides -- keeping them separate means a
   * row-2 warning's justification history never gets conflated with a
   * row-3 block's. Appended (never removed) by `DesignRegistry.decideReview`
   * when a review carrying `symbolConflictWaivers` is approved -- see
   * `PendingReview.symbolConflictWaivers`. */
  justifiedSymbolConflicts: string[];
}

/** 2026-08-26 terminology simplification: collapsed from a three-way
 * `"canonical_abstraction" | "domain_fact" | "review_required"` union to a
 * single value. Checked against every reader in the codebase (matching,
 * severity, blocking, the admin-justify resolution flow) and found they
 * treated all three identically -- the only thing `type` ever changed was
 * which one-line phrase a deny message printed. The field stays on the wire
 * (rather than being removed outright) specifically to avoid repeating the
 * cross-repo break recorded for the `constraints` payload key rename
 * (twing-monitor reads response shapes this repo doesn't control) -- only
 * the number of values it can take collapses, not its presence. */
export type DesignConstraintType = "constraint";

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

/**
 * The four-bucket design-conflict model (2026-08-26 terminology
 * simplification, superseding the prior five-verdict/severity/
 * three-constraint-type/separate-align-vocabulary sprawl -- see
 * docs/design-terminology.md and this repo's own memory of the design
 * discussion that produced it). One principle: approval belongs to
 * whoever's authority you'd be overriding.
 *
 * - `"file_overlap"`: two designs' *declared* plans (self-reported
 *   `creates`/`touches`) name the same file, before either has written a
 *   line. Always advisory -- never blocks, never flags, nothing to
 *   resolve. (Was `"overlap"` tier 1; tier 4's Jaccard summary-similarity
 *   fallback is dropped entirely as of this change, redundant with
 *   `"llm_divergence"` below.)
 * - `"constraint_violation"`: one design vs. a fixed project rule
 *   (`DesignConstraintType`, now a single value -- see its own doc
 *   comment). Always blocks. The one bucket where a third party (an
 *   admin) approves an override, not the developer who hit it -- it's
 *   someone else's rule, not theirs to waive alone. (Was
 *   `"constraint_flag"`.)
 * - `"symbol_conflict"`: two designs' *actual edits* collide -- a real
 *   edit lands on a symbol another open design's owner also edited, or
 *   declared as their own scope, or whose signature it silently broke.
 *   Sourced from real `Claim`s (Tree-sitter), not self-reported scope --
 *   see `checks.ts`/`design-divergence.ts`. Always blocks (whichever
 *   side(s) have an open design at the time). Self-approvable: no third
 *   party's rule is being overridden, just a peer collision, so whoever
 *   ends up blocked can justify and clear their own block.
 * - `"llm_divergence"`: two designs' *stated intent* conflict --
 *   duplication, contradictory assumptions, or tension in shared system
 *   behavior, judged by the semantic comparator
 *   (`design-semantic-check.ts`'s `checkSemanticConflict`, driven by
 *   app.ts's `runSemanticComparatorPass`) even when file lists never
 *   overlap. Never returned synchronously by `runDesignChecks`
 *   (design-checks.ts's tiers 1/3 run against the request that triggered
 *   them); only ever set via `DesignRegistry.flag()` from the async
 *   comparator pass, after its response has already been sent. Self-
 *   approvable, same reasoning as `"symbol_conflict"`. (Was `"conflict"`.)
 * - `"has_open_designs"`: not actually a conflict between two designs at
 *   all -- a pre-registration hygiene check on one developer (too much of
 *   their own work open at once), running *before* any row exists for
 *   this request. Only reachable from `POST /v1/designs/check`'s
 *   structured (non-`rawPlanText`) path, i.e. `twing design register`,
 *   never `ExitPlanMode` -- see `DesignCheckResult.openDesigns`'s doc
 *   comment.
 *
 * `DesignSeverity`/`severity` is gone as of this change: with tier 4 and
 * the three-way constraint type both collapsed, whether a verdict blocks
 * is now a pure, static function of the verdict itself (`file_overlap`
 * never does; the other three always do) -- a field that can no longer
 * vary independently of its own verdict was dead weight. Every former
 * `severity === "error"` check becomes a static per-verdict table instead.
 */
export type DesignVerdict = "clean" | "file_overlap" | "constraint_violation" | "symbol_conflict" | "llm_divergence" | "has_open_designs";

export type DesignOverlapKind = "creates" | "touches" | "constraint" | "symbol";

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
  /** Absent only for `"has_open_designs"` -- that verdict fires *before* a
   * row is created (see DesignVerdict's own doc comment), so there is no id
   * to report yet. Every other verdict always has one. */
  designId?: string;
  conflicts?: DesignConflict[];
  /** Every constraint the checked scope matched (2026-08-22 -- was a single
   * `constraint` object; `matchConstraintsForPaths` used to collapse to one
   * "best" hit even when several different constraints each matched a
   * different target path, so a session justifying the one it saw would
   * only discover the next one on retry. See design-checks.ts's own doc
   * comment on `matchConstraintsForPaths` for the full reasoning. */
  constraints?: { id: string; statement: string; type: DesignConstraintType }[];
  /** Set only for `"has_open_designs"` (2026-08-25) -- the developer's other
   * currently-open designs, cross-project, that a plain `twing design
   * register` call found before creating a new row. Lets the CLI print
   * "here's what you already have open" without a second round trip. Never
   * set for any other verdict. */
  openDesigns?: { id: string; projectId: string; summary: string; lastActivityAt: number }[];
}

export interface PendingReview {
  id: string;
  designId: string;
  projectId: string;
  justification: string;
  createdAt: number;
  decision?: "approve" | "reject";
  /** Set only when this review was created against a `constraint_violation`
   * verdict (undefined for a `symbol_conflict`/`llm_divergence`-triggered
   * justified_divergence). Recorded so an approval can be attributed to the
   * *specific* constraints
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
   * (2026-08-22) -- set only when this design currently has an
   * `"llm_divergence"` flag against it (recorded conflicts, not recomputed
   * live at justify-time: unlike `overlapWaivers`'s cheap local recompute, a
   * live recheck here would mean a second synchronous LLM call inside
   * `/v1/designs/:id/resolve`). One entry per conflicting design, no paths
   * -- see DesignStatement.justifiedConflicts for how an approval consumes
   * this. */
  conflictWaivers?: { conflictingDesignId: string }[];
  /** `"symbol_conflict"`'s counterpart to `overlapWaivers` above
   * (2026-08-26) -- sourced the same way `conflictWaivers` is: read back
   * from this design's open `category: "symbol_conflict"` alignment
   * threads (`symbolIds`/`designId`), not recomputed live -- there's no
   * cheap local recompute for "which real edits collided" the way
   * `structuralOverlaps` provides for `overlapWaivers`. One entry per
   * conflicting design, naming the specific symbols that collided -- see
   * DesignStatement.justifiedSymbolConflicts for how an approval consumes
   * this. */
  symbolConflictWaivers?: { conflictingDesignId: string; symbolIds: string[] }[];
}

/**
 * `GET /v1/reviews`'s response shape (2026-08-25). A bare `PendingReview`
 * carries only the requester's own `justification` plus opaque ids, which
 * is the least useful subset of what a reviewer needs: it names the
 * argument for letting the work through without naming the work, who wants
 * it, or what stopped it. An admin was being asked to approve a sentence.
 *
 * Every added field is optional, so this stays a pure superset -- an older
 * dashboard reading this response is unaffected, and a review whose design
 * has since been deleted still serializes cleanly rather than 500ing.
 * Nothing here is stored: it's assembled per request from rows that already
 * exist (see review-enrich.ts), so there's no schema change and no risk of
 * the copy drifting from the design it describes.
 */
export interface ReviewDesignSummary {
  summary: string;
  creates: string[];
  touches: string[];
  developerId: string;
  status: DesignStatement["status"];
}

export interface ReviewConstraintSummary {
  id: string;
  statement: string;
  type: DesignConstraintType;
}

/** `overlapWaivers` (path collisions) and `conflictWaivers` (the semantic
 * comparator's judgement) are separate concepts internally, and an approval
 * consumes them differently. To a human deciding, they're one question --
 * "whose work does this collide with, and how do I know?" -- so they're
 * merged here, with `kind` preserving which check produced it. */
export interface ReviewConflictSummary {
  designId: string;
  kind: "overlap" | "conflict" | "symbol_conflict";
  /** Absent if the conflicting design has since been deleted. */
  summary?: string;
  developerId?: string;
  /** Set for `kind: "overlap"` and `kind: "symbol_conflict"` -- the
   * semantic comparator (`kind: "conflict"`) has no specific path to point
   * at. */
  paths?: string[];
}

export interface EnrichedPendingReview extends PendingReview {
  /** Absent only if the design was deleted after the review was raised. */
  design?: ReviewDesignSummary;
  /** Resolved from `constraintIds`. Absent when the review came from an
   * overlap rather than a constraint. */
  constraints?: ReviewConstraintSummary[];
  /** `overlapWaivers` and `conflictWaivers`, resolved and merged. */
  conflicts?: ReviewConflictSummary[];
}
