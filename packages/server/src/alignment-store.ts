/**
 * Alignment threads (statefulness redesign, 2026-08) -- the "conversation
 * layer" for a `symbol_conflict` or `llm_divergence` finding (see
 * `checks.ts`/`design-divergence.ts` for the three finding kinds that feed
 * `symbol_conflict`, and `design-semantic-check.ts` for `llm_divergence`):
 * async, mailbox-style, never live. A thread is a small current-state table
 * (id, parties, status), exactly like `designs`; every message in it,
 * including the auto-generated seed note, is an `activity_events` row
 * (`kind: "alignment_message_posted"`) rather than a separate `messages`
 * table -- same "current-state table + log entries" pattern as everything
 * else in this schema, and it keeps the history genuinely append-only.
 *
 * The thread itself stays purely advisory -- closing it (below) is
 * unilateral and never blocks or unblocks a tool call by itself. As of the
 * 2026-08-26 terminology simplification, both `symbol_conflict` and
 * `llm_divergence` *do* independently flag/block via `DesignRegistry.flag()`
 * (see app.ts) -- the thread is the conversation about *why*, cleared via
 * `twing design resolve --justify` (self-approvable for both buckets), not
 * by closing the thread. See `DesignVerdict`'s doc comment in
 * core/types.ts for the full model.
 */

import * as crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { alignmentThreads as threadsTable } from "./db/schema.js";
import { DrizzleActivityLog } from "./activity-log.js";

/** Which of the two self-approvable design-conflict buckets a thread
 * represents (2026-08-26 terminology simplification -- see
 * `DesignVerdict`'s doc comment in core/types.ts for the full four-bucket
 * model). Collapsed from a four-way
 * `"duplication" | "contradictory_assumptions" | "tension" | "symbol_claim"`
 * union: those four were a bucket name and its sub-reason tangled into one
 * field. The bucket name is now just these two values; the old four values
 * survive as `subKind` below, detail text under the bucket rather than a
 * competing top-level name. A pre-2026-08-26 row keeps its old value here
 * unconverted -- never backfilled, same convention this table already
 * followed for its pre-2026-08-23 rows; a reader that needs to treat old
 * rows uniformly with new ones should go through `legacyCategoryBucket`
 * below rather than compare `category` directly. */
export type AlignmentCategory = "symbol_conflict" | "llm_divergence";

/** Detail label shown under the bucket name -- `duplication` /
 * `contradictory_assumptions` / `tension` for `llm_divergence` (mirrors
 * `SemanticConflictKind`, `design-semantic-check.ts`, its only producer),
 * or `real_edit_collision` / `scope_intrusion` / `contract_break` for
 * `symbol_conflict` (mirrors the three finding kinds that now feed it --
 * `textual_overlap` / `design_divergence` / `contract_divergence`, see
 * `checks.ts`/`design-divergence.ts`). Undefined on any row that predates
 * this column. */
export type AlignmentSubKind = "duplication" | "contradictory_assumptions" | "tension" | "real_edit_collision" | "scope_intrusion" | "contract_break";

/** Legacy pre-2026-08-26 `category` strings, mapped to which of the two
 * current buckets they represent -- for any reader that needs to treat old
 * rows uniformly with new ones (list-view filtering, etc.) without a
 * backfill. */
export function legacyCategoryBucket(raw: string): AlignmentCategory | undefined {
  switch (raw) {
    case "duplication":
    case "contradictory_assumptions":
    case "tension":
      return "llm_divergence";
    case "symbol_claim":
      return "symbol_conflict";
    default:
      return undefined;
  }
}

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
  /** Detail label under the bucket name -- see `AlignmentSubKind`'s own
   * doc comment. Undefined on any row that predates this column. */
  subKind?: AlignmentSubKind;
  /** Short, list-view label -- distinct from `systemDescription`, which
   * stays the full-text description. Undefined on pre-2026-08-23 rows. */
  summary?: string;
  /** Every distinct overlapping path/symbol accumulated across amendments.
   * Only meaningful for `category: "symbol_conflict"`. Falls back to
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
  subKind: AlignmentSubKind;
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
  subKind: string | null;
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
    subKind: (row.subKind as AlignmentSubKind | null) ?? undefined,
    summary: row.summary ?? undefined,
    symbolIds: parsedSymbolIds.length > 0 ? parsedSymbolIds : row.symbolId ? [row.symbolId] : [],
    initiatingDesignId: row.initiatingDesignId ?? undefined,
    lastActivityAt: row.lastActivityAt ?? row.openedAt,
  };
}

/** Short list-view label per sub-kind -- deterministic, no LLM call (the
 * semantic comparator already spent one producing `systemDescription`'s
 * full reason; this just needs a title). Capped defensively so a long
 * design summary can't blow up the list view. Keyed by `subKind`, not the
 * top-level `category` -- the label needs the specific reason
 * ("duplicate work" vs. "contradicts"), which only the sub-kind carries. */
export function buildAlignmentSummary(subKind: AlignmentSubKind, otherDesignSummary: string, symbolCount: number): string {
  const other = otherDesignSummary.length > 80 ? `${otherDesignSummary.slice(0, 79)}…` : otherDesignSummary || "(no summary)";
  switch (subKind) {
    case "duplication":
      return `Duplicate work with "${other}"`;
    case "contradictory_assumptions":
      return `Contradicts "${other}"`;
    case "tension":
      return `Tension with "${other}"`;
    case "real_edit_collision":
      return `${symbolCount} overlapping symbol${symbolCount === 1 ? "" : "s"} with "${other}"`;
    case "scope_intrusion":
      return `Edit landed inside "${other}"'s declared scope`;
    case "contract_break":
      return `Signature change breaks a live caller in "${other}"`;
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
      subKind: input.subKind,
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
        subKind: thread.subKind ?? null,
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
    // A symbol_conflict thread only has something new to say when a symbol
    // it hasn't seen before shows up; an llm_divergence re-check is always
    // itself a fresh LLM finding, so it's always worth a follow-up message.
    const hasNewSignal = input.category !== "symbol_conflict" || newSymbolIds.length > 0;
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
