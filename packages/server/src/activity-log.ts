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
import { and, eq, gt, lt, asc, desc, inArray, notInArray } from "drizzle-orm";
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
  /** Unilateral admin deletion (`ConstraintStore.remove`) -- same
   * immediate-effect shape as `constraint_ratified`/`constraint_updated`
   * above, just for removal. See that method's own doc comment for why
   * this isn't the staged/approval redesign. */
  | "constraint_removed"
  /** Async semantic-conflict comparator (design-semantic-check.ts) flagged
   * a conflict between two designs that the syntactic tiers (design-
   * checks.ts) missed or weren't asked about -- always advisory, feeds the
   * same alignment-thread/notice pipeline as design_divergence. */
  | "design_semantic_conflict"
  | "alignment_thread_opened"
  | "alignment_message_posted"
  | "alignment_thread_closed"
  /** Tightening alignment threads item 4 (2026-08-27): a thread's
   * `initiatingDesignId`/`designId` design went dormant (see
   * `design_dormant` above) and its counterpart was already
   * resolved/closed/dormant too -- see `AlignmentThreadStore.dormant`'s own
   * doc comment for why this is a distinct outcome from
   * `alignment_thread_closed`. */
  | "alignment_thread_dormant"
  /** The symmetric wake-up: `design_resumed` reactivated a design, and a
   * dormant thread naming it woke back up to "open" -- see
   * `AlignmentThreadStore.wake`. */
  | "alignment_thread_woken"
  /** Reopen-on-new-finding fix (2026-08-28): a genuinely new finding landed
   * against a pair whose thread had already `alignment_thread_closed`, and
   * at least one of the two designs behind it is still live -- see
   * `AlignmentThreadStore.reopen` and `FindOrCreateInput.reopenEligible`'s
   * own doc comment. Distinct from `alignment_thread_woken` above (that's
   * specifically the dormant-thread path, triggered by `design resume`) --
   * this is the closed-thread path, triggered by `findOrCreate` reacting to
   * a fresh finding, not a party's own action. */
  | "alignment_thread_reopened"
  /** Change D (2026-08-31, design-gate registration-flow fixes):
   * `DesignRegistry.reassignProject` moved an open design into a different
   * project -- a fix-in-place for a wrong-project registration, guarded to
   * only ever fire on a design nothing downstream depends on yet (see that
   * method's own doc comment). Logged under the *new* project; the
   * design's earlier `design_registered`/`design_checked` rows correctly
   * stay under the old one, per this table's insert-only convention. */
  | "design_reassigned"
  /** A project's `settings: designDormantAfter` changed and every one of
   * its live (open/flagged) designs was re-timed to the new window
   * (2026-09-11, `DesignRegistry.retimeActiveDesigns`). Deliberately **one
   * row per re-timing, not per design** -- the only break from this
   * table's usual one-row-per-entity convention. A re-time is a single
   * administrative act on the project, `twing init` re-runs it every time
   * it's invoked, and a project with fifty open designs would otherwise
   * emit fifty identical rows per run and drown the feed it's meant to
   * make readable. `relatedId` is therefore absent (no single entity to
   * point at) and the payload carries `{ttlMs, designCount}` instead.
   * Only ever appended when something actually changed -- re-seeding an
   * unchanged value logs nothing at all. */
  | "design_retimed"
  /** Design review (2026-09). All five carry `relatedId = <comment id>`,
   * not the design id -- deliberately, because `eventsForRelatedId` is how
   * a comment's reply history is read back, exactly as an alignment
   * thread's messages are. The design id lives in the payload instead, for
   * anyone filtering the project feed by design.
   *
   * `design_comment_replied` is the one that carries conversation; its
   * payload is `{designId, commentId, authorKind, message}`. `authorKind`
   * has to be *stored* rather than inferred from `developerId`: a developer
   * replying through the CLI and their agent replying through the CLI
   * authenticate with the same token, so the identity on the row cannot
   * tell the two apart. */
  | "design_comment_posted"
  | "design_comment_replied"
  /** A reviewer decided the agent's first-pass answer wasn't enough and
   * pulled the human developer in -- the only comment event that ever
   * reaches anyone's coding session. */
  | "design_comment_escalated"
  /** The design's owner (or their agent, by reading the comment) has seen
   * the escalation. Stops the session banner repeating, and is deliberately
   * *not* the same as resolving -- see `designComments.acknowledgedAt`. */
  | "design_comment_acknowledged"
  | "design_comment_resolved"
  /** Design review phase 2 (2026-09): one turn in a reviewer's private chat
   * with a design. `relatedId` is the chat row's id, so
   * `eventsForRelatedId` reads the conversation back the same way it reads
   * a comment's replies.
   *
   * Unlike every other event here, these are **not** project-readable
   * history: a chat belongs to one reviewer, and the only path that returns
   * these rows checks that the caller owns the thread. The project activity
   * feed filters them out -- see `eventsForProjectPage`'s kind allowlist. */
  | "design_chat_message";

/**
 * Event kinds that are **never** part of a project's shared history, however
 * a caller asks for them.
 *
 * Everything else in this table is a record of something that happened to
 * the project and is readable by its members, which is the whole design of
 * the activity log. A `design_chat_message` is the exception: it belongs to
 * one reviewer, and the only path that may return it is the one that checks
 * they own the thread (`DesignChatStore.messages`, which reads by
 * `relatedId` and is called behind an ownership check).
 *
 * A kind added here becomes invisible to `eventsForProjectPage` and so to
 * `GET /v1/activity`. Adding one is a deliberate act; the log's default is
 * still that a project can see its own history.
 */
const PRIVATE_EVENT_KINDS: readonly ActivityEventKind[] = ["design_chat_message"];

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

  /** twing-monitor v1: newest-first page for the dashboard's activity feed
   * (unlike `eventsForProject`'s oldest-first audit-trail read above).
   * `before` (ms epoch, exclusive) is the "load older" cursor; `kinds`
   * narrows to an allowlist. `activity_events_project_ts_idx` (db/schema.ts)
   * already covers the (projectId, ts) half of this query. Fetches one row
   * past `limit` purely to know whether a `nextBefore` cursor is worth
   * returning -- that extra row is never included in `items`.
   *
   * No secondary tiebreaker on `ts` ties (accepted v1 gap): two events in
   * the exact same millisecond that straddle a page boundary could see one
   * silently excluded by the next page's `before=` (exclusive) cursor.
   * Real activity is seconds/minutes apart, not synchronous sub-millisecond
   * bursts, so this isn't expected to matter in practice -- revisit with a
   * compound (ts, id) cursor if it ever does.
   *
   * `developerId` (twing-monitor, 2026-08-19): lets the dashboard's
   * activity feed narrow to one developer's own events -- e.g. clicking a
   * developer name on one row to see just their history -- without pulling
   * a whole project's feed client-side just to filter it.
   *
   * `relatedId` (twing-monitor, 2026-08-19): lets a caller ask "what
   * happened to this one design/thread/constraint" -- the design detail
   * panel's "why was this flagged" section uses it to fetch just that
   * design's own `design_checked`/`design_flagged` history instead of
   * scanning the whole project feed for it. Distinct from
   * `eventsForRelatedId` above: that one is oldest-first and unpaginated
   * (built for "replay a thread's full message history"), this stays
   * newest-first/paginated/kind-filterable like the rest of this method. */
  eventsForProjectPage(
    projectId: string,
    options: { before?: number; limit?: number; kinds?: ActivityEventKind[]; developerId?: string; relatedId?: string } = {},
  ): { items: ActivityEvent[]; nextBefore?: number } {
    const limit = Math.min(options.limit ?? 50, 200);
    // Excluded here rather than in the route, and unconditionally rather
    // than by asking callers to filter: `kinds` and `relatedId` below are
    // *caller-supplied*, so a project feed with no `?kind=` returns
    // everything, and `?relatedId=<chatId>` reads one thread directly. A
    // reviewer's private chat with a design must not be reachable either
    // way, and putting the rule at the store means a future route cannot
    // reintroduce the hole by forgetting about it.
    const conditions = [eq(activityEvents.projectId, projectId), notInArray(activityEvents.kind, [...PRIVATE_EVENT_KINDS])];
    if (options.before !== undefined) conditions.push(lt(activityEvents.ts, options.before));
    if (options.kinds && options.kinds.length > 0) conditions.push(inArray(activityEvents.kind, options.kinds));
    if (options.developerId) conditions.push(eq(activityEvents.developerId, options.developerId));
    if (options.relatedId) conditions.push(eq(activityEvents.relatedId, options.relatedId));
    const rows = this.db
      .select()
      .from(activityEvents)
      .where(and(...conditions))
      .orderBy(desc(activityEvents.ts))
      .limit(limit + 1)
      .all() as ActivityEventRow[];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(fromRow);
    return { items, nextBefore: hasMore ? items[items.length - 1].ts : undefined };
  }
}
