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
  /** Trigger ids only, never the pattern text (§10). */
  triggerMatches?: string[];
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
export type FindingKind = "textual_overlap" | "contract_divergence" | "trigger_duplication" | "design_divergence" | "design_semantic_conflict";

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

export const DEFAULT_DESIGN_TTL_MS = 24 * 60 * 60 * 1000;

export interface DesignStatement {
  id: string;
  projectId: string;
  developerId: string;
  sessionId: string;
  agentLabel?: string;
  status: "open" | "superseded" | "closed" | "expired";
  createdAt: number;
  closedAt?: number;
  summary: string;
  creates: string[];
  touches: string[];
  dependsOn: string[];
  rawPlanExcerpt?: string;
  ttlMs: number;
  /** Set once a justified-divergence review on this design is decided --
   * durable independent of later `status` changes (e.g. reopening on
   * approval), so it's a directly-queryable precedent fact for later
   * compounding rather than something only recoverable by joining
   * PendingReview. Undefined means no review was ever attached, or one is
   * still pending. */
  reviewDecision?: "approve" | "reject";
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

export type DesignOverlapKind = "creates" | "touches" | "depends_on" | "constraint";

export interface DesignConflict {
  conflictingDesignId: string;
  agentLabel?: string;
  overlapKind: DesignOverlapKind;
  overlapDetail: string;
  conflictingSummary: string;
}

export interface DesignCheckResult {
  verdict: DesignVerdict;
  designId: string;
  conflicts?: DesignConflict[];
  constraint?: { statement: string; type: DesignConstraintType };
}

export interface PendingReview {
  id: string;
  designId: string;
  projectId: string;
  justification: string;
  createdAt: number;
  decision?: "approve" | "reject";
}
