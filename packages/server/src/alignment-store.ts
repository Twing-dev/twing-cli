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

/** What kind of divergence a thread represents -- 2026-08-23. The three
 * semantic values mirror `SemanticConflictKind` (`design-semantic-check.ts`)
 * exactly, since that's their only producer; `symbol_claim` is the
 * claims-path (`design-divergence.ts`) equivalent -- a real edit landing in
 * someone else's declared scope, as opposed to two designs' *content*
 * conflicting. Undefined on pre-2026-08-23 rows (never backfilled -- see
 * this file's header comment on why old threads stay as-is). */
export type AlignmentCategory = "duplication" | "contradictory_assumptions" | "tension" | "symbol_claim";

export interface AlignmentThread {
  id: string;
  projectId: string;
  /** Legacy single-symbol/design-id-stand-in field -- see `findOrCreate`'s
   * doc comment. Kept for old rows; new code reads/writes `symbolIds`
   * instead. */
  symbolId: string;
  developerId: string;
  otherDeveloperId: string;
  designId?: string;
  status: "open" | "closed";
  systemDescription: string;
  openedAt: number;
  closedAt?: number;
  closedBy?: string;
  category?: AlignmentCategory;
  /** Short, list-view label -- distinct from `systemDescription`, which
   * stays the full-text description. Undefined on pre-2026-08-23 rows. */
  summary?: string;
  /** Every distinct overlapping path/symbol accumulated across amendments.
   * Only meaningful for `category: "symbol_claim"`. Falls back to
   * `[symbolId]` for a pre-2026-08-23 row that never had this column. */
  symbolIds: string[];
  /** The initiating developer's own open design, when one resolves --
   * best-effort, and deliberately absent (not a bug) when the initiating
   * edit had no design behind it at all: the design gate has real, supported
   * bypasses (`disable-gate`), and `Bash` skips both the gate and claim
   * capture entirely (`wire-hooks.ts`'s matchers), so it's not even a claim.
   * Never cleared back to undefined once resolved. */
  initiatingDesignId?: string;
  /** Bumped on every amendment; falls back to `openedAt` for a thread that's
   * never been amended (or predates this column). */
  lastActivityAt: number;
}

export interface AlignmentMessage {
  authorId?: string;
  message: string;
  ts: number;
}

export interface FindOrCreateInput {
  projectId: string;
  /** Every overlapping path/symbol this particular signal names -- usually
   * one entry (a single claim, or `[]` for a semantic-conflict finding,
   * which has no real symbol to name). Merged into the thread's accumulated
   * `symbolIds` on both create and amend. */
  symbolIds: string[];
  developerId: string;
  otherDeveloperId: string;
  designId?: string;
  systemDescription: string;
  category: AlignmentCategory;
  summary: string;
  initiatingDesignId?: string;
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
  category: string | null;
  summary: string | null;
  symbolIds: string;
  initiatingDesignId: string | null;
  lastActivityAt: number | null;
}

function fromRow(row: ThreadRow): AlignmentThread {
  const parsedSymbolIds = JSON.parse(row.symbolIds) as string[];
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
    category: (row.category as AlignmentCategory | null) ?? undefined,
    summary: row.summary ?? undefined,
    symbolIds: parsedSymbolIds.length > 0 ? parsedSymbolIds : row.symbolId ? [row.symbolId] : [],
    initiatingDesignId: row.initiatingDesignId ?? undefined,
    lastActivityAt: row.lastActivityAt ?? row.openedAt,
  };
}

/** Short list-view label per category -- deterministic, no LLM call (the
 * semantic comparator already spent one producing `systemDescription`'s
 * full reason; this just needs a title). Capped defensively so a long
 * design summary can't blow up the list view. */
export function buildAlignmentSummary(category: AlignmentCategory, otherDesignSummary: string, symbolCount: number): string {
  const other = otherDesignSummary.length > 80 ? `${otherDesignSummary.slice(0, 79)}…` : otherDesignSummary || "(no summary)";
  switch (category) {
    case "duplication":
      return `Duplicate work with "${other}"`;
    case "contradictory_assumptions":
      return `Contradicts "${other}"`;
    case "tension":
      return `Tension with "${other}"`;
    case "symbol_claim":
      return `${symbolCount} overlapping path${symbolCount === 1 ? "" : "s"} with "${other}"`;
  }
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

  /** Reuses an already-open thread for the same (project, developer pair,
   * target design) rather than forking a new one on repeat detection of the
   * same underlying divergence.
   *
   * 2026-08-23: the dedup key used to include `symbolId`, so every new
   * overlapping symbol between the same two developers opened *another*
   * thread -- confirmed live as the actual cause of a single design pair
   * accumulating 14 simultaneous open threads (one per touched file/symbol).
   * Dropping `symbolId` from the key and amending the existing thread
   * instead -- merging new `symbolIds` in, bumping `lastActivityAt`, and
   * posting a follow-up message only when something genuinely new is being
   * recorded -- is the actual fix; see this file's header comment on why a
   * follow-up message rather than a silent mutation. */
  findOrCreate(input: FindOrCreateInput): AlignmentThread {
    const dedupConditions = [
      eq(threadsTable.projectId, input.projectId),
      eq(threadsTable.developerId, input.developerId),
      eq(threadsTable.otherDeveloperId, input.otherDeveloperId),
      eq(threadsTable.status, "open"),
    ];
    if (input.designId) dedupConditions.push(eq(threadsTable.designId, input.designId));
    const existingRow = this.db
      .select()
      .from(threadsTable)
      .where(and(...dedupConditions))
      .get() as ThreadRow | undefined;
    if (existingRow) return this.amend(existingRow, input);

    const ts = input.ts ?? Date.now();
    const thread: AlignmentThread = {
      id: crypto.randomUUID(),
      projectId: input.projectId,
      symbolId: input.symbolIds[0] ?? "",
      developerId: input.developerId,
      otherDeveloperId: input.otherDeveloperId,
      designId: input.designId,
      status: "open",
      systemDescription: input.systemDescription,
      openedAt: ts,
      category: input.category,
      summary: input.summary,
      symbolIds: input.symbolIds,
      initiatingDesignId: input.initiatingDesignId,
      lastActivityAt: ts,
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
        category: thread.category ?? null,
        summary: thread.summary ?? null,
        symbolIds: JSON.stringify(thread.symbolIds),
        initiatingDesignId: thread.initiatingDesignId ?? null,
        lastActivityAt: thread.lastActivityAt,
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

  /** The repeat-signal half of `findOrCreate` above: merges a new finding
   * into an already-open thread instead of forking. */
  private amend(existingRow: ThreadRow, input: FindOrCreateInput): AlignmentThread {
    const existing = fromRow(existingRow);
    const ts = input.ts ?? Date.now();
    const mergedSymbolIds = Array.from(new Set([...existing.symbolIds, ...input.symbolIds]));
    const newSymbolIds = input.symbolIds.filter((s) => !existing.symbolIds.includes(s));
    // A symbol_claim thread only has something new to say when a symbol it
    // hasn't seen before shows up; a semantic-conflict re-check is always
    // itself a fresh LLM finding, so it's always worth a follow-up message.
    const hasNewSignal = input.category !== "symbol_claim" || newSymbolIds.length > 0;
    const resolvedInitiatingDesignId = existing.initiatingDesignId ?? input.initiatingDesignId;

    this.db
      .update(threadsTable)
      .set({
        symbolIds: JSON.stringify(mergedSymbolIds),
        lastActivityAt: ts,
        ...(resolvedInitiatingDesignId ? { initiatingDesignId: resolvedInitiatingDesignId } : {}),
      })
      .where(eq(threadsTable.id, existing.id))
      .run();

    if (hasNewSignal) {
      this.activityLog.append({
        projectId: existing.projectId,
        developerId: input.developerId,
        kind: "alignment_message_posted",
        relatedId: existing.id,
        ts,
        payload: { message: input.systemDescription },
      });
    }

    return {
      ...existing,
      symbolIds: mergedSymbolIds,
      lastActivityAt: ts,
      initiatingDesignId: resolvedInitiatingDesignId,
    };
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
