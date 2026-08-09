/**
 * Claim/CallEdge/Notice data model, per design doc §11. Signatures are
 * type/name-level, never implementation bodies — see the payload boundary
 * note in §11 and §4a of the memo.
 */

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
}
