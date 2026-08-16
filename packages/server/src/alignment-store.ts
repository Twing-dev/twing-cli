/**
 * Alignment threads (statefulness redesign, 2026-08) -- the "conversation
 * layer" for a `design_divergence` finding (`design-divergence.ts`):
 * async, mailbox-style, never live. A thread is a small current-state table
 * (id, parties, status), exactly like `designs`; every message in it,
 * including the auto-generated seed note, is an `activity_events` row
 * (`kind: "alignment_message_posted"`) rather than a separate `messages`
 * table -- same "current-state table + log entries" pattern as everything
 * else in this schema, and it keeps the history genuinely append-only.
 *
 * Deliberately advisory: nothing here ever blocks a tool call. Closing a
 * thread is unilateral -- either party can close it without the other
 * agreeing, since this is for voluntary reconciliation, not enforcement.
 */

import * as crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { alignmentThreads as threadsTable } from "./db/schema.js";
import { DrizzleActivityLog } from "./activity-log.js";

export interface AlignmentThread {
  id: string;
  projectId: string;
  symbolId: string;
  developerId: string;
  otherDeveloperId: string;
  designId?: string;
  status: "open" | "closed";
  systemDescription: string;
  openedAt: number;
  closedAt?: number;
  closedBy?: string;
}

export interface AlignmentMessage {
  authorId?: string;
  message: string;
  ts: number;
}

export interface FindOrCreateInput {
  projectId: string;
  symbolId: string;
  developerId: string;
  otherDeveloperId: string;
  designId?: string;
  systemDescription: string;
  ts?: number;
}

interface ThreadRow {
  id: string;
  projectId: string;
  symbolId: string;
  developerId: string;
  otherDeveloperId: string;
  designId: string | null;
  status: string;
  systemDescription: string;
  openedAt: number;
  closedAt: number | null;
  closedBy: string | null;
}

function fromRow(row: ThreadRow): AlignmentThread {
  return {
    id: row.id,
    projectId: row.projectId,
    symbolId: row.symbolId,
    developerId: row.developerId,
    otherDeveloperId: row.otherDeveloperId,
    designId: row.designId ?? undefined,
    status: row.status as AlignmentThread["status"],
    systemDescription: row.systemDescription,
    openedAt: row.openedAt,
    closedAt: row.closedAt ?? undefined,
    closedBy: row.closedBy ?? undefined,
  };
}

export interface AlignmentThreadStoreOptions {
  /** Typed against the concrete `DrizzleActivityLog`, not the write-only
   * `ActivityLogWriter` interface `Store`/`DesignRegistry` use -- this store's
   * `messages()` genuinely needs the read helpers (`eventsForRelatedId`),
   * which aren't part of that narrower interface. */
  activityLog?: DrizzleActivityLog;
}

export class AlignmentThreadStore {
  private db: Db;
  private activityLog: DrizzleActivityLog;

  constructor(db: Db, options: AlignmentThreadStoreOptions = {}) {
    this.db = db;
    this.activityLog = options.activityLog ?? new DrizzleActivityLog(db);
  }

  /** Reuses an already-open thread for the same (project, symbol, both
   * parties) rather than opening a duplicate on repeat detection of the
   * same divergence. */
  findOrCreate(input: FindOrCreateInput): AlignmentThread {
    const existingRow = this.db
      .select()
      .from(threadsTable)
      .where(
        and(
          eq(threadsTable.projectId, input.projectId),
          eq(threadsTable.symbolId, input.symbolId),
          eq(threadsTable.developerId, input.developerId),
          eq(threadsTable.otherDeveloperId, input.otherDeveloperId),
          eq(threadsTable.status, "open"),
        ),
      )
      .get() as ThreadRow | undefined;
    if (existingRow) return fromRow(existingRow);

    const ts = input.ts ?? Date.now();
    const thread: AlignmentThread = {
      id: crypto.randomUUID(),
      projectId: input.projectId,
      symbolId: input.symbolId,
      developerId: input.developerId,
      otherDeveloperId: input.otherDeveloperId,
      designId: input.designId,
      status: "open",
      systemDescription: input.systemDescription,
      openedAt: ts,
    };
    this.db
      .insert(threadsTable)
      .values({
        id: thread.id,
        projectId: thread.projectId,
        symbolId: thread.symbolId,
        developerId: thread.developerId,
        otherDeveloperId: thread.otherDeveloperId,
        designId: thread.designId ?? null,
        status: thread.status,
        systemDescription: thread.systemDescription,
        openedAt: thread.openedAt,
        closedAt: null,
        closedBy: null,
      })
      .run();
    this.activityLog.append({
      projectId: thread.projectId,
      kind: "alignment_thread_opened",
      relatedId: thread.id,
      ts,
    });
    // The seed note is itself the thread's first message, so its full
    // history (system note + replies) reads back as one ordered sequence.
    this.activityLog.append({
      projectId: thread.projectId,
      kind: "alignment_message_posted",
      relatedId: thread.id,
      ts,
      payload: { message: thread.systemDescription },
    });
    return thread;
  }

  get(id: string): AlignmentThread | undefined {
    const row = this.db.select().from(threadsTable).where(eq(threadsTable.id, id)).get() as ThreadRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  listByProject(projectId: string, status?: AlignmentThread["status"]): AlignmentThread[] {
    const conditions = [eq(threadsTable.projectId, projectId)];
    if (status) conditions.push(eq(threadsTable.status, status));
    const rows = this.db
      .select()
      .from(threadsTable)
      .where(and(...conditions))
      .all() as ThreadRow[];
    return rows.map(fromRow);
  }

  /** Full message history for a thread, oldest first -- the system seed
   * note plus every reply, all from the same append-only log. */
  messages(threadId: string): AlignmentMessage[] {
    return this.activityLog
      .eventsForRelatedId(threadId)
      .filter((e) => e.kind === "alignment_message_posted")
      .map((e) => ({ authorId: e.developerId, message: (e.payload as { message: string }).message, ts: e.ts }));
  }

  postMessage(threadId: string, authorId: string, message: string): AlignmentMessage | undefined {
    const thread = this.get(threadId);
    if (!thread) return undefined;
    const ts = Date.now();
    this.activityLog.append({
      projectId: thread.projectId,
      developerId: authorId,
      kind: "alignment_message_posted",
      relatedId: threadId,
      ts,
      payload: { message },
    });
    return { authorId, message, ts };
  }

  /** Unilateral -- either party can close a thread without the other
   * agreeing; this is advisory, not a negotiation with a required outcome.
   * Idempotent: closing an already-closed thread is a no-op, not a second
   * log entry. */
  close(threadId: string, closedBy: string): AlignmentThread | undefined {
    const thread = this.get(threadId);
    if (!thread) return undefined;
    if (thread.status === "closed") return thread;
    const closedAt = Date.now();
    this.db.update(threadsTable).set({ status: "closed", closedAt, closedBy }).where(eq(threadsTable.id, threadId)).run();
    this.activityLog.append({
      projectId: thread.projectId,
      developerId: closedBy,
      kind: "alignment_thread_closed",
      relatedId: threadId,
      ts: closedAt,
    });
    return this.get(threadId);
  }
}
