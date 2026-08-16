/**
 * In-memory coordination store (§7). Sized for what this actually is — a
 * couple dozen concurrent dev sessions, not a multi-tenant platform.
 *
 * Claims/CallEdges deliberately stay pure in-memory `Map`s, unchanged by
 * the statefulness redesign (2026-08): every daemon keeps its own local
 * claim history and re-reports on its next debounce cycle, so the shared
 * *current-state* view rebuilds itself within seconds after a restart --
 * not worth a durable current-state table (see schema.ts's header comment
 * for the full "why designs get a table and claims don't" reasoning). What
 * does change: `upsert()` now writes one `claim_recorded`/`call_edge_recorded`
 * activity-log row per new/changed item, so the *history* of what was
 * claimed survives a restart even though the live Maps don't -- durable
 * audit trail without turning the hot capture path into a per-heartbeat DB
 * round trip.
 */

import type { Claim, CallEdge, Notice } from "@twing/core";
import type { Db } from "./db/client.js";
import { DrizzleActivityLog, type ActivityLogWriter } from "./activity-log.js";

interface StoredNotice extends Notice {
  ts: number;
  developerId: string;
}

const SWEEP_INTERVAL_MS = 60_000;

export interface StoreOptions {
  activityLog?: ActivityLogWriter;
}

export class Store {
  private claims = new Map<string, Claim>();
  private callEdges = new Map<string, CallEdge[]>(); // keyed by projectId
  private notices = new Map<string, StoredNotice[]>(); // keyed by developerId
  private activityLog: ActivityLogWriter;

  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(db: Db, options: StoreOptions = {}) {
    this.activityLog = options.activityLog ?? new DrizzleActivityLog(db);
    this.sweepTimer = setInterval(() => this.sweepExpired(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  stop(): void {
    clearInterval(this.sweepTimer);
  }

  /** Same symbol+session refreshes in place rather than accumulating
   * duplicates — matches ttlMs being "refreshed on session activity" (§11). */
  private claimKey(claim: Claim): string {
    return `${claim.projectId}::${claim.developerId}::${claim.sessionId}::${claim.symbolId}::${claim.stage}`;
  }

  private isActive(claim: Claim, now: number): boolean {
    return claim.ts + claim.ttlMs > now;
  }

  /** Upserts claims and call edges, returning just the claims that are new
   * or changed in this batch (what the divergence checks should run against —
   * everything already active was already checked when it first arrived).
   * Also durably logs one `claim_recorded`/`call_edge_recorded` activity
   * event per new/changed item -- the in-memory Maps below are unaffected
   * by this and remain the sole source for liveness checks. */
  upsert(projectId: string, claims: Claim[], edges: CallEdge[]): Claim[] {
    const changed: Claim[] = [];
    for (const claim of claims) {
      const key = this.claimKey(claim);
      const existing = this.claims.get(key);
      if (!existing || existing.ts !== claim.ts) {
        changed.push(claim);
      }
      this.claims.set(key, claim);
    }

    for (const claim of changed) {
      this.activityLog.append({
        projectId: claim.projectId,
        developerId: claim.developerId,
        sessionId: claim.sessionId,
        kind: "claim_recorded",
        relatedId: claim.symbolId,
        ts: claim.ts,
        payload: claim,
      });
    }

    if (edges.length > 0) {
      const existingEdges = this.callEdges.get(projectId) ?? [];
      const seen = new Set(existingEdges.map((e) => `${e.callerSymbolId}->${e.calleeSymbolId}`));
      const now = Date.now();
      for (const edge of edges) {
        const key = `${edge.callerSymbolId}->${edge.calleeSymbolId}`;
        if (!seen.has(key)) {
          seen.add(key);
          existingEdges.push(edge);
          this.activityLog.append({
            projectId,
            kind: "call_edge_recorded",
            relatedId: edge.callerSymbolId,
            ts: now,
            payload: edge,
          });
        }
      }
      this.callEdges.set(projectId, existingEdges);
    }

    return changed;
  }

  /** All active (non-expired) claims in a project. */
  activeClaims(projectId: string, now: number = Date.now()): Claim[] {
    const result: Claim[] = [];
    for (const claim of this.claims.values()) {
      if (claim.projectId === projectId && this.isActive(claim, now)) {
        result.push(claim);
      }
    }
    return result;
  }

  callEdgesFor(projectId: string): CallEdge[] {
    return this.callEdges.get(projectId) ?? [];
  }

  addNotice(developerId: string, message: string, ts: number = Date.now(), threadId?: string): void {
    const list = this.notices.get(developerId) ?? [];
    list.push({ message, ts, developerId, threadId });
    this.notices.set(developerId, list);
  }

  /** GET /v1/notices?developerId=&since= — findings generated after the
   * caller's last poll, including ones triggered by someone else's later
   * activity (§7). */
  noticesSince(developerId: string, since: number): Notice[] {
    return (this.notices.get(developerId) ?? []).filter((n) => n.ts > since).map((n) => ({ message: n.message, threadId: n.threadId }));
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [key, claim] of this.claims) {
      if (!this.isActive(claim, now)) this.claims.delete(key);
    }
    // Notices are cheap and self-limiting in practice (one per finding);
    // sweep anything older than the longest claim ttl so polling stragglers
    // still see a recent finding, without the list growing unbounded.
    const noticeMaxAgeMs = 24 * 60 * 60 * 1000;
    for (const [developerId, list] of this.notices) {
      const kept = list.filter((n) => n.ts + noticeMaxAgeMs > now);
      if (kept.length === 0) this.notices.delete(developerId);
      else this.notices.set(developerId, kept);
    }
  }
}
