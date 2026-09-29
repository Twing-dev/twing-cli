/**
 * Design review comments (2026-09) -- the first human-initiated channel in
 * this system.
 *
 * Everything that came before runs agent-to-agent (`Claim`/`Finding`/
 * `AlignmentThread`, all machine-opened about a detected collision) or
 * agent-to-human (a gate deny). This one runs the other way: a reviewer reads
 * a design in twing-monitor, highlights the part they have a question about,
 * and comments on it, before any code exists to review. That direction is the
 * entire point -- it is the one moment where redirecting an agent is nearly
 * free.
 *
 * **People answer, nothing else does** (2026-09-27). The first version had the
 * coordinator answer every comment with a model call, then let the reviewer
 * escalate to the developer if that was not enough. The coordinator holds
 * designs, not code, so those answers were guesses about a codebase it had
 * never seen. What the system does instead is make sure the design's owner
 * *knows* there is something waiting (`openReviewsFor`, surfaced in their
 * coding sessions by the hook) and leaves the answering to them.
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
import type { CommentAnchor, CommentAnchorField, DesignComment, DesignCommentReply, DesignCommentStatus } from "@twing/core";
import type { Db } from "./db/client.js";
import { designComments as commentsTable, designs as designsTable } from "./db/schema.js";
import { DrizzleActivityLog } from "./activity-log.js";

interface CommentRow {
  id: string;
  projectId: string;
  designId: string;
  authorId: string;
  body: string;
  anchorField: string | null;
  anchorChangeId: string | null;
  anchorQuote: string | null;
  anchorPrefix: string | null;
  anchorSuffix: string | null;
  designVersion: number;
  status: string;
  resolvedAt: number | null;
  resolvedBy: string | null;
  createdAt: number;
  updatedAt: number;
}

function anchorFromRow(row: CommentRow): CommentAnchor | undefined {
  if (!row.anchorField || row.anchorQuote === null) return undefined;
  return {
    field: row.anchorField as CommentAnchorField,
    ...(row.anchorChangeId ? { changeId: row.anchorChangeId } : {}),
    quote: row.anchorQuote,
    ...(row.anchorPrefix ? { prefix: row.anchorPrefix } : {}),
    ...(row.anchorSuffix ? { suffix: row.anchorSuffix } : {}),
  };
}

function fromRow(row: CommentRow): DesignComment {
  const anchor = anchorFromRow(row);
  return {
    id: row.id,
    projectId: row.projectId,
    designId: row.designId,
    authorId: row.authorId,
    body: row.body,
    ...(anchor ? { anchor } : {}),
    designVersion: row.designVersion,
    status: row.status as DesignCommentStatus,
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
  /** Already validated against the design by the route
   * (`validateCommentAnchor`, design-comment-anchor.ts). */
  anchor?: CommentAnchor;
  /** The design's `scopeVersion` at the moment of commenting. */
  designVersion: number;
}

export interface AddReplyInput {
  commentId: string;
  authorId: string;
  message: string;
}

/** Every unresolved comment on one design, as its owner's coding sessions
 * hear about it. Ids only -- see `OpenReviewNotice` in core for why the text
 * stays out. */
export interface OpenReview {
  designId: string;
  projectId: string;
  designSummary: string;
  commentIds: string[];
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
      anchorField: input.anchor?.field ?? null,
      anchorChangeId: input.anchor?.changeId ?? null,
      anchorQuote: input.anchor?.quote ?? null,
      anchorPrefix: input.anchor?.prefix ?? null,
      anchorSuffix: input.anchor?.suffix ?? null,
      designVersion: input.designVersion,
      status: "open",
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
      payload: { designId: input.designId, commentId: row.id, anchorField: input.anchor?.field },
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
        const payload = (event.payload ?? {}) as { message?: unknown };
        return {
          commentId,
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
      payload: { designId: comment.designId, commentId: comment.id, message: input.message },
    });
    this.touch(comment.id, now);
    return { commentId: comment.id, authorId: input.authorId, message: input.message, ts: now };
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
   * Every design this developer owns that has an unresolved comment on it,
   * with the ids of those comments.
   *
   * **Keyed on the design's `developerId`, never on the caller's identity
   * alone.** A person's dashboard-login identity (`join-via-github`, e.g.
   * `2063…+someuser@users.noreply.github.com`) can differ from the identity
   * their CLI authors designs under (their git-email-derived one) --
   * documented live at `canViewThread` in `app.ts`, and the common case for
   * anyone using both surfaces. This is read by the daemon, which calls with
   * the CLI identity, which is the one on the design row.
   *
   * Scoped to designs in any status. A design closes at session end, and a
   * review of it routinely arrives after that -- filtering to open designs
   * would drop most of the comments this exists to surface.
   *
   * "Unresolved" rather than "waiting on a reply", deliberately: whether a
   * reply answered the question is the asker's call, and they make it by
   * resolving. Until then the owner keeps being told.
   */
  openReviewsFor(developerId: string): OpenReview[] {
    const rows = this.db
      .select({ commentId: commentsTable.id, designId: commentsTable.designId, projectId: commentsTable.projectId, designSummary: designsTable.summary })
      .from(commentsTable)
      .innerJoin(designsTable, eq(commentsTable.designId, designsTable.id))
      .where(and(eq(commentsTable.status, "open"), eq(designsTable.developerId, developerId)))
      .orderBy(asc(commentsTable.createdAt))
      .all() as { commentId: string; designId: string; projectId: string; designSummary: string }[];

    const byDesign = new Map<string, OpenReview>();
    for (const row of rows) {
      const entry = byDesign.get(row.designId) ?? { designId: row.designId, projectId: row.projectId, designSummary: row.designSummary, commentIds: [] };
      entry.commentIds.push(row.commentId);
      byDesign.set(row.designId, entry);
    }
    return [...byDesign.values()];
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
