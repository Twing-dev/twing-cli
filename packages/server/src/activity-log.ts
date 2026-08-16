/**
 * Unified activity log (statefulness redesign, 2026-08) -- the append-only
 * "what got proposed, refined, modified, approved, reverted" record the
 * statefulness memo asked for, now spanning both the §4 (Claim/Finding) and
 * §17 (DesignStatement/PendingReview) families in one table. Every store
 * that mutates durable state (`Store`, `DesignRegistry`, `AlignmentThreadStore`)
 * takes an `ActivityLogWriter` and appends exactly one event per transition,
 * in the same call that makes the transition -- there is no separate
 * replay/projection step.
 *
 * Insert-only by convention: this class has no update/delete method, and
 * none should ever be added. The value of this table is the sequence, not
 * just the latest state -- that's what a current-state table (`designs`,
 * `alignment_threads`, ...) is for.
 */

import * as crypto from "node:crypto";
import { and, eq, gt, asc } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { activityEvents } from "./db/schema.js";

export type ActivityEventKind =
  | "claim_recorded"
  | "call_edge_recorded"
  | "finding_raised"
  | "design_registered"
  | "design_checked"
  | "design_resolved"
  | "review_created"
  | "review_decided"
  | "design_closed"
  | "design_expired"
  /** §17 scope enforcement (2026-08): a design's own registration/amendment
   * verdict wasn't `clean` -- it's persisted as `status: "flagged"` instead
   * of `"open"` (see `DesignRegistry.flag`). */
  | "design_flagged"
  /** §17 scope enforcement (2026-08): `DesignRegistry.amend` expanded an
   * open design's creates/touches/dependsOn after a clean re-check. */
  | "design_amended"
  /** §17 design lifecycle (2026-08): `DesignRegistry.sweepExpired` demoted
   * an open/flagged design to "dormant" for no activity within `ttlMs`. */
  | "design_dormant"
  /** §17 design lifecycle (2026-08): `DesignRegistry.resume` reactivated a
   * dormant design, possibly reassigning it to a different developer/
   * session -- payload carries both the from- and to- identity. */
  | "design_resumed"
  /** §17 design lifecycle (2026-08): a session registered a new design
   * while it already had another non-overlapping open/flagged design --
   * advisory only, never changes the sibling's status (see app.ts's
   * registration-time stale-sibling notice). */
  | "design_stale_sibling_suggested"
  | "constraint_ratified"
  /** §17.2 cold-start seed (`add`, design-store.ts): a repo's committed
   * `.twing/twing.yml` re-seeded a constraint whose statement text already
   * existed for this project, but with a different scope/type -- the
   * upsert now applies that change instead of silently discarding it
   * (found live, 2026-08-16: narrowing an existing constraint's scope in
   * the local file had no effect at all before this, since the seed
   * endpoint's upsert was keyed on statement text and returned the
   * existing row unchanged on any match). */
  | "constraint_updated"
  /** Async semantic-conflict comparator (design-semantic-check.ts) flagged
   * a conflict between two designs that the syntactic tiers (design-
   * checks.ts) missed or weren't asked about -- always advisory, feeds the
   * same alignment-thread/notice pipeline as design_divergence. */
  | "design_semantic_conflict"
  | "alignment_thread_opened"
  | "alignment_message_posted"
  | "alignment_thread_closed";

export interface ActivityEvent {
  id: string;
  projectId: string;
  /** Absent for system-generated events (e.g. a TTL-sweep expiry). */
  developerId?: string;
  sessionId?: string;
  kind: ActivityEventKind;
  /** Points at a designId/reviewId/threadId/symbolId depending on `kind`. */
  relatedId?: string;
  ts: number;
  payload?: unknown;
}

export interface ActivityLogWriter {
  append(event: Omit<ActivityEvent, "id">): ActivityEvent;
}

interface ActivityEventRow {
  id: string;
  projectId: string;
  developerId: string | null;
  sessionId: string | null;
  kind: string;
  relatedId: string | null;
  ts: number;
  payload: string | null;
}

function fromRow(row: ActivityEventRow): ActivityEvent {
  return {
    id: row.id,
    projectId: row.projectId,
    developerId: row.developerId ?? undefined,
    sessionId: row.sessionId ?? undefined,
    kind: row.kind as ActivityEventKind,
    relatedId: row.relatedId ?? undefined,
    ts: row.ts,
    payload: row.payload !== null ? JSON.parse(row.payload) : undefined,
  };
}

export class DrizzleActivityLog implements ActivityLogWriter {
  constructor(private db: Db) {}

  append(event: Omit<ActivityEvent, "id">): ActivityEvent {
    const full: ActivityEvent = { ...event, id: crypto.randomUUID() };
    this.db
      .insert(activityEvents)
      .values({
        id: full.id,
        projectId: full.projectId,
        developerId: full.developerId ?? null,
        sessionId: full.sessionId ?? null,
        kind: full.kind,
        relatedId: full.relatedId ?? null,
        ts: full.ts,
        payload: full.payload !== undefined ? JSON.stringify(full.payload) : null,
      })
      .run();
    return full;
  }

  /** Every event tied to one designId/reviewId/threadId, oldest first --
   * what an alignment thread's message history is read back as. */
  eventsForRelatedId(relatedId: string): ActivityEvent[] {
    return this.db.select().from(activityEvents).where(eq(activityEvents.relatedId, relatedId)).orderBy(asc(activityEvents.ts)).all().map(fromRow);
  }

  /** Every event for a project, optionally only those after `since` --
   * general-purpose audit-trail read, oldest first. */
  eventsForProject(projectId: string, since?: number): ActivityEvent[] {
    const where = since !== undefined ? and(eq(activityEvents.projectId, projectId), gt(activityEvents.ts, since)) : eq(activityEvents.projectId, projectId);
    return this.db.select().from(activityEvents).where(where).orderBy(asc(activityEvents.ts)).all().map(fromRow);
  }
}
