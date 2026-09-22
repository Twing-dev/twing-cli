/**
 * Design review comments (2026-09) -- the first human-initiated channel in
 * this system.
 *
 * Everything that came before runs agent-to-agent (`Claim`/`Finding`/
 * `AlignmentThread`, all machine-opened about a detected collision) or
 * agent-to-human (a gate deny). This one runs the other way: a reviewer reads
 * a design in twing-monitor and asks a question about it, before any code
 * exists to review. That direction is the entire point -- it is the one moment
 * where redirecting an agent is nearly free.
 *
 * Same "current-state table + append-only log" split as `alignment-store.ts`,
 * and for the same reason: the comment's *state* is queried and updated, while
 * every reply is history that must never be rewritten. So replies are
 * `activity_events` rows (`design_comment_replied`, `relatedId = commentId`)
 * rather than a `design_comment_replies` table, read back through
 * `DrizzleActivityLog.eventsForRelatedId` exactly as thread messages are.
 *
 * Deliberately *not* folded into `AlignmentThreadStore` despite the shape
 * rhyming. A thread is machine-opened between two named developers and is
 * party-only: an admin can read it but not speak in it. A comment is
 * human-opened on a design and is visible and answerable by the whole project.
 * One table serving both would need authorization rules that contradict each
 * other.
 *
 * `authorId` is always the identity resolved from the authenticated token,
 * never a field the client sent -- the rule every write in this package
 * follows (§17.10 hardening).
 */

import * as crypto from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { DesignComment, DesignCommentReply, DesignCommentStatus, CommentAuthorKind } from "@twing/core";
import type { Db } from "./db/client.js";
import { designComments as commentsTable, designs as designsTable } from "./db/schema.js";
import { DrizzleActivityLog } from "./activity-log.js";

interface CommentRow {
  id: string;
  projectId: string;
  designId: string;
  authorId: string;
  body: string;
  targetChangeId: string | null;
  status: string;
  agentAnsweredAt: number | null;
  escalatedAt: number | null;
  escalatedBy: string | null;
  acknowledgedAt: number | null;
  resolvedAt: number | null;
  resolvedBy: string | null;
  createdAt: number;
  updatedAt: number;
}

function fromRow(row: CommentRow): DesignComment {
  return {
    id: row.id,
    projectId: row.projectId,
    designId: row.designId,
    authorId: row.authorId,
    body: row.body,
    targetChangeId: row.targetChangeId ?? undefined,
    status: row.status as DesignCommentStatus,
    agentAnsweredAt: row.agentAnsweredAt ?? undefined,
    escalatedAt: row.escalatedAt ?? undefined,
    escalatedBy: row.escalatedBy ?? undefined,
    acknowledgedAt: row.acknowledgedAt ?? undefined,
    resolvedAt: row.resolvedAt ?? undefined,
    resolvedBy: row.resolvedBy ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface CreateCommentInput {
  projectId: string;
  designId: string;
  /** Resolved from the token by the route, never from the request body. */
  authorId: string;
  body: string;
  targetChangeId?: string;
}

export interface AddReplyInput {
  commentId: string;
  authorKind: CommentAuthorKind;
  /** Absent for the coordinator's own first-pass answer, which no developer
   * authored. */
  authorId?: string;
  message: string;
}

/** One escalated comment joined to the design it sits on -- what the session
 * banner is rendered from. Joined here rather than by the caller because the
 * ownership test ("designs this developer owns") is what makes the query
 * correct, and leaving that to a route would be leaving an authorization
 * decision somewhere it can be forgotten. */
export interface PendingEscalation {
  comment: DesignComment;
  designSummary: string;
  designStatus: string;
}

export class DesignCommentStore {
  private db: Db;
  private activityLog: DrizzleActivityLog;

  constructor(db: Db, options: { activityLog?: DrizzleActivityLog } = {}) {
    this.db = db;
    // Typed against the concrete `DrizzleActivityLog` rather than the
    // write-only `ActivityLogWriter` interface, same as AlignmentThreadStore:
    // `replies()` genuinely needs `eventsForRelatedId`, which that narrower
    // interface doesn't carry.
    this.activityLog = options.activityLog ?? new DrizzleActivityLog(db);
  }

  create(input: CreateCommentInput): DesignComment {
    const now = Date.now();
    const row: CommentRow = {
      id: crypto.randomUUID(),
      projectId: input.projectId,
      designId: input.designId,
      authorId: input.authorId,
      body: input.body,
      targetChangeId: input.targetChangeId ?? null,
      status: "open",
      agentAnsweredAt: null,
      escalatedAt: null,
      escalatedBy: null,
      acknowledgedAt: null,
      resolvedAt: null,
      resolvedBy: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(commentsTable).values(row).run();
    this.activityLog.append({
      projectId: input.projectId,
      developerId: input.authorId,
      kind: "design_comment_posted",
      relatedId: row.id,
      ts: now,
      payload: { designId: input.designId, commentId: row.id, targetChangeId: input.targetChangeId },
    });
    return fromRow(row);
  }

  get(id: string): DesignComment | undefined {
    const row = this.db.select().from(commentsTable).where(eq(commentsTable.id, id)).get() as CommentRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  /** Oldest first: a comment thread reads as a conversation, and a reviewer
   * scanning one wants the question before the answers. The opposite of the
   * activity feed's newest-first ordering, deliberately. */
  listByDesign(designId: string): DesignComment[] {
    return (this.db.select().from(commentsTable).where(eq(commentsTable.designId, designId)).orderBy(asc(commentsTable.createdAt)).all() as CommentRow[]).map(fromRow);
  }

  /** Replies under one comment, oldest first. */
  replies(commentId: string): DesignCommentReply[] {
    return this.activityLog
      .eventsForRelatedId(commentId)
      .filter((event) => event.kind === "design_comment_replied")
      .map((event) => {
        const payload = (event.payload ?? {}) as { authorKind?: unknown; message?: unknown };
        return {
          commentId,
          // An unrecognised/absent authorKind reads as "human": the failure
          // mode that matters is a model's answer being mistaken for a
          // person's, not the reverse.
          authorKind: payload.authorKind === "agent" ? "agent" : ("human" as CommentAuthorKind),
          authorId: event.developerId,
          message: typeof payload.message === "string" ? payload.message : "",
          ts: event.ts,
        };
      });
  }

  /** Replies for several comments at once -- what `GET /v1/designs/:id/comments`
   * needs so rendering a design's whole discussion is one query rather than
   * one per comment. */
  repliesFor(commentIds: string[]): Record<string, DesignCommentReply[]> {
    const out: Record<string, DesignCommentReply[]> = {};
    for (const id of commentIds) out[id] = this.replies(id);
    return out;
  }

  addReply(input: AddReplyInput): DesignCommentReply | undefined {
    const comment = this.get(input.commentId);
    if (!comment) return undefined;
    const now = Date.now();
    this.activityLog.append({
      projectId: comment.projectId,
      developerId: input.authorId,
      kind: "design_comment_replied",
      relatedId: comment.id,
      ts: now,
      payload: { designId: comment.designId, commentId: comment.id, authorKind: input.authorKind, message: input.message },
    });
    this.touch(comment.id, now);
    return { commentId: comment.id, authorKind: input.authorKind, authorId: input.authorId, message: input.message, ts: now };
  }

  /**
   * Records that the agent took its first pass.
   *
   * Only ever moves `open` -> `answered`. A comment a reviewer already
   * escalated (or resolved) must not be dragged back by a slow model call
   * landing afterwards: the async answer pass and a reviewer's click race by
   * construction, and the reviewer's decision is the one that reflects a
   * human's judgement. The reply itself is still posted either way -- it is
   * history, and losing it would hide what the model actually said.
   */
  markAnswered(commentId: string): DesignComment | undefined {
    const existing = this.get(commentId);
    if (!existing) return undefined;
    const now = Date.now();
    if (existing.status !== "open") {
      this.touch(commentId, now);
      return this.get(commentId);
    }
    this.db.update(commentsTable).set({ status: "answered", agentAnsweredAt: now, updatedAt: now }).where(eq(commentsTable.id, commentId)).run();
    return this.get(commentId);
  }

  /**
   * A human follow-up landed, so there is an unanswered question again.
   *
   * Moves `answered` back to `open`, which is not a hack: `open` means
   * "there is a human question on this thread the agent has not answered
   * yet", and after a follow-up that is exactly true again. Reusing the
   * existing state rather than adding a fifth one means every consumer
   * already does the right thing -- the dashboard shows "the agent is
   * answering…" and switches to its fast poll, `markAnswered` closes it out
   * the same way it does a first pass, and nothing had to learn a new value.
   *
   * Refuses to touch `escalated` or `resolved`, mirroring `markAnswered`'s
   * own guard in the other direction: a person owns those, and nothing the
   * agent does should drag them back into a machine state.
   */
  markAwaitingAnswer(commentId: string): DesignComment | undefined {
    const existing = this.get(commentId);
    if (!existing) return undefined;
    if (existing.status !== "answered") return existing;
    const now = Date.now();
    this.db.update(commentsTable).set({ status: "open", updatedAt: now }).where(eq(commentsTable.id, commentId)).run();
    return this.get(commentId);
  }

  /**
   * A reviewer decided the agent's answer wasn't enough.
   *
   * Deliberately allowed from `open` as well as `answered`: a reviewer who
   * already knows this needs the human should not have to wait out a model
   * call to say so. Refused only once `resolved` -- re-opening a settled
   * question is a new comment, not a state change on an old one.
   */
  escalate(commentId: string, escalatedBy: string, reason?: string): DesignComment | undefined {
    const existing = this.get(commentId);
    if (!existing || existing.status === "resolved") return undefined;
    const now = Date.now();
    this.db
      .update(commentsTable)
      .set({ status: "escalated", escalatedAt: now, escalatedBy, acknowledgedAt: null, updatedAt: now })
      .where(eq(commentsTable.id, commentId))
      .run();
    this.activityLog.append({
      projectId: existing.projectId,
      developerId: escalatedBy,
      kind: "design_comment_escalated",
      relatedId: commentId,
      ts: now,
      payload: { designId: existing.designId, commentId, reason },
    });
    return this.get(commentId);
  }

  /**
   * The design's owner has seen the escalation.
   *
   * Clears it from their session banner and nothing else: `status` stays
   * `escalated` until somebody actually resolves it. That separation is the
   * point -- an agent reading a comment acknowledges it automatically (see
   * the `twing design comments` path), and if acknowledging also resolved,
   * an agent could silently close a reviewer's open question just by looking
   * at it.
   */
  acknowledge(commentId: string, developerId: string): DesignComment | undefined {
    const existing = this.get(commentId);
    if (!existing) return undefined;
    // Idempotent: the agent reads its comments on every session, and a second
    // read is not a second event.
    if (existing.acknowledgedAt) return existing;
    const now = Date.now();
    this.db.update(commentsTable).set({ acknowledgedAt: now, updatedAt: now }).where(eq(commentsTable.id, commentId)).run();
    this.activityLog.append({
      projectId: existing.projectId,
      developerId,
      kind: "design_comment_acknowledged",
      relatedId: commentId,
      ts: now,
      payload: { designId: existing.designId, commentId },
    });
    return this.get(commentId);
  }

  resolve(commentId: string, resolvedBy: string): DesignComment | undefined {
    const existing = this.get(commentId);
    if (!existing || existing.status === "resolved") return existing;
    const now = Date.now();
    this.db.update(commentsTable).set({ status: "resolved", resolvedAt: now, resolvedBy, updatedAt: now }).where(eq(commentsTable.id, commentId)).run();
    this.activityLog.append({
      projectId: existing.projectId,
      developerId: resolvedBy,
      kind: "design_comment_resolved",
      relatedId: commentId,
      ts: now,
      payload: { designId: existing.designId, commentId },
    });
    return this.get(commentId);
  }

  /**
   * Every escalated, unacknowledged comment on a design this developer owns.
   *
   * **Keyed on the design's `developerId`, never on the caller's identity.**
   * That is not a stylistic choice: a person's dashboard-login identity
   * (`join-via-github`, e.g. `2063…+someuser@users.noreply.github.com`) can
   * differ from the identity their CLI authors designs under (their
   * git-email-derived one) -- documented live at `canViewThread` in `app.ts`,
   * and the common case for anyone using both surfaces. The escalation has to
   * reach whoever is *building* the design, which is the identity on the
   * design row, so that is what this joins on.
   *
   * Scoped to designs in any status. A commit -- and therefore a review of it
   * -- routinely lands after `handleSessionEnd` has already closed the
   * design, so filtering to open designs here would silently drop exactly the
   * escalations that arrive late, which is most of them.
   */
  pendingEscalationsFor(developerId: string): PendingEscalation[] {
    const rows = this.db
      .select({ comment: commentsTable, designSummary: designsTable.summary, designStatus: designsTable.status })
      .from(commentsTable)
      .innerJoin(designsTable, eq(commentsTable.designId, designsTable.id))
      .where(and(eq(commentsTable.status, "escalated"), eq(designsTable.developerId, developerId)))
      .orderBy(asc(commentsTable.escalatedAt))
      .all() as { comment: CommentRow; designSummary: string; designStatus: string }[];

    return rows
      .filter((row) => row.comment.acknowledgedAt === null)
      .map((row) => ({ comment: fromRow(row.comment), designSummary: row.designSummary, designStatus: row.designStatus }));
  }

  /**
   * How many comments each of these designs carries, and how many are still
   * unresolved -- the list-view chip in twing-monitor, as one query rather
   * than one per row.
   *
   * `projectId` is required, not optional, and is ANDed into the query
   * rather than checked afterwards. The caller supplies the design ids, so
   * without it a member of one project could ask about another project's
   * designs and learn how much discussion they carry -- the authorization
   * happened against the project, so the project has to constrain the rows.
   * Making it a required parameter means a future caller cannot reintroduce
   * that by forgetting to pass it.
   */
  countsByDesign(designIds: string[], projectId: string): Record<string, { total: number; unresolved: number }> {
    const out: Record<string, { total: number; unresolved: number }> = {};
    if (designIds.length === 0) return out;
    const rows = this.db
      .select()
      .from(commentsTable)
      .where(and(eq(commentsTable.projectId, projectId), inArray(commentsTable.designId, designIds)))
      .all() as CommentRow[];
    for (const row of rows) {
      const entry = (out[row.designId] ??= { total: 0, unresolved: 0 });
      entry.total += 1;
      if (row.status !== "resolved") entry.unresolved += 1;
    }
    return out;
  }

  private touch(commentId: string, ts: number): void {
    this.db.update(commentsTable).set({ updatedAt: ts }).where(eq(commentsTable.id, commentId)).run();
  }
}
