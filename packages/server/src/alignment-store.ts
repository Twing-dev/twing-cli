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
import { and, eq, or, lt, sql } from "drizzle-orm";
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
  /** Tightening alignment threads item 4 (2026-08-27): widened from
   * `"open" | "closed"` to add `"dormant"` -- distinct from `"closed"`
   * because dormancy is explicitly reversible for a design (`resume()`
   * exists specifically for this). A thread goes dormant when the design
   * lifecycle behind it goes quiet on its own (see `dormant()`/`wake()`
   * below), never as a deliberate party action -- that distinction is
   * exactly why it isn't folded into `"closed"`. Plain `text` column, no DB
   * migration needed for the widen.
   *
   * 2026-08-28: `"closed"` also gained a reopen path (`reopen()`, below) --
   * `findOrCreate` uses it when a genuinely new finding lands against a
   * pair whose thread already closed, but only while at least one of the
   * two designs behind it is still live; see `FindOrCreateInput.reopenEligible`'s
   * own doc comment for the full reasoning. */
  status: "open" | "closed" | "dormant";
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
  /** Reopen-on-new-finding fix (2026-08-28): whether *this* finding is still
   * actionable by someone right now -- true when at least one of the two
   * designs behind it is currently live (`"open"` or `"flagged"`; computed
   * by the caller, which has live design state this store doesn't). Only
   * consulted when `findOrCreate` matches an existing thread that's already
   * `"closed"`/`"dormant"`: `true` reopens/wakes it before amending, `false`
   * leaves its status exactly where it was (the finding still gets recorded
   * -- `amend()` posts its message unconditionally regardless of status --
   * there's just nobody left to act on it, so reopening would only be
   * noise). Never reopens a *design* itself -- designs never leave
   * `"closed"` once there; this only ever changes the advisory thread's own
   * status. Irrelevant (and ignored) when the match is already `"open"` or
   * when there's no match at all. */
  reopenEligible: boolean;
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

/** Dashboard pagination (monitor UI load-time fix, 2026-08-29) -- same
 * default/cap as `design-store.ts`'s own copy of these constants, kept as
 * a second literal pair rather than a shared import since this is the only
 * other place they're needed and a shared constants module would be
 * overkill for two integers. */
const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 100;

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
   * follow-up message rather than a silent mutation.
   *
   * 2026-08-26: same bug class, different axis -- direction. `checks.ts`'s
   * `recordSymbolConflict` resolves and flags *both* sides in one call, so
   * `symbol_conflict` naturally gets one shared thread. `llm_divergence`
   * doesn't: `runSemanticComparatorPass` only ever checks the *current*
   * design being registered/amended against everything else already open --
   * one-directional by construction. When A registers and gets checked
   * against B's open design, then B later registers/amends and gets
   * checked against A's, those are two separate calls with
   * `developerId`/`otherDeveloperId` in opposite order (A,B) vs (B,A) -- the
   * forward-only dedup above never recognized them as the same underlying
   * tension between the same two designs, so it forked a second thread
   * (confirmed live: two separate threads for what was one disagreement
   * between one pair of designs). Fixed by also matching the *reverse*
   * shape: a reverse call's `otherDeveloperId`/`developerId` swap the
   * existing row's `developerId`/`otherDeveloperId`, and its `designId`
   * (the *other* side's design, from the new caller's point of view) is the
   * existing row's `initiatingDesignId` (the side that got flagged
   * *first*) -- and symmetrically, the reverse call's own
   * `initiatingDesignId` is the existing row's `designId`. Both design-id
   * links are required together (not just one) so this can't accidentally
   * merge two genuinely-different conflicts that happen to share only one
   * side; either id being unresolved (as `checkAmendedScope`'s callers
   * sometimes are) just skips the reverse match, same forward-only
   * fallback as before this fix.
   *
   * 2026-08-28: dropped `status === "open"` from the match itself -- a
   * thread that already closed or went dormant for this exact design pair
   * used to be invisible here, so a genuinely new finding against it forked
   * *another* thread rather than reopening the existing conversation, the
   * same fan-out bug class as 2026-08-23's `symbolId`-keyed one above, just
   * triggered by "closed" instead of "never existed" -- confirmed live
   * against a thread whose async `llm_divergence` check landed a few ms
   * after the initiating design closed. Found while investigating a
   * different-looking symptom: `runSemanticComparatorPass` still posting a
   * fresh-looking message into an *already-open* thread whose both sides
   * had genuinely settled, with nothing to re-run the close check
   * afterward (see `maybeAutoCloseThread`'s call site, app.ts). A matched
   * row that's closed/dormant is reopened/woken here -- but only when
   * `input.reopenEligible` says the finding is still actionable (see its
   * own doc comment); otherwise `amend()` below still records the finding
   * (it posts unconditionally, regardless of status) without touching the
   * thread's own status. Designs themselves are never reopened by this --
   * only the advisory thread. */
  findOrCreate(input: FindOrCreateInput): AlignmentThread {
    const forward = [
      eq(threadsTable.projectId, input.projectId),
      eq(threadsTable.developerId, input.developerId),
      eq(threadsTable.otherDeveloperId, input.otherDeveloperId),
    ];
    if (input.designId) forward.push(eq(threadsTable.designId, input.designId));

    const conditions = [and(...forward)!];
    if (input.designId && input.initiatingDesignId) {
      conditions.push(
        and(
          eq(threadsTable.projectId, input.projectId),
          eq(threadsTable.developerId, input.otherDeveloperId),
          eq(threadsTable.otherDeveloperId, input.developerId),
          eq(threadsTable.initiatingDesignId, input.designId),
          eq(threadsTable.designId, input.initiatingDesignId),
        )!,
      );
    }
    const existingRow = this.db
      .select()
      .from(threadsTable)
      .where(or(...conditions))
      .get() as ThreadRow | undefined;
    if (existingRow) {
      if (input.reopenEligible && existingRow.status === "closed") {
        this.reopen(existingRow.id);
        existingRow.status = "open";
        existingRow.closedAt = null;
        existingRow.closedBy = null;
      } else if (input.reopenEligible && existingRow.status === "dormant") {
        this.wake(existingRow.id);
        existingRow.status = "open";
      }
      return this.amend(existingRow, input);
    }

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

  /** `DesignRegistry.reassignProject`'s guard (Change D, 2026-08-31): a
   * design already named in a reconciliation thread -- as either the party
   * whose claim triggered it (`designId`) or the initiator whose own open
   * design it was checked against (`initiatingDesignId`) -- has real
   * cross-developer conversation attached under its current project;
   * moving it out from under that thread would leave the thread's own
   * `projectId` pointing at a project the design itself no longer belongs
   * to. Any status (open or closed) counts, matching
   * `DesignRegistry.hasReviewForDesign`'s same reasoning. Uses the new
   * `alignment_threads_design_id_idx`/`alignment_threads_initiating_design_id_idx`
   * (`db/schema.ts`). */
  hasThreadForDesign(designId: string): boolean {
    const row = this.db
      .select({ id: threadsTable.id })
      .from(threadsTable)
      .where(or(eq(threadsTable.designId, designId), eq(threadsTable.initiatingDesignId, designId)))
      .limit(1)
      .get();
    return row !== undefined;
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

  /** twing-monitor's `GET /v1/alignment-threads` -- the paginated
   * counterpart to `listByProject` above, same reasoning as
   * `DesignRegistry.listByProjectPage` (design-store.ts): a new, separate
   * method, since every other caller of `listByProject` in app.ts (open
   * design flag/resume/dormancy flows) needs the complete set for real
   * correctness, not a page of it. Cursor is `COALESCE(lastActivityAt,
   * openedAt)` -- the same "most recent activity, falling back to when it
   * opened" ordering `AlignmentThreadsView` already computes client-side
   * today (`fromRow`'s own fallback, above), just moved server-side so it
   * composes with a page boundary. `listByProject` itself stays exactly as
   * today -- unpaginated *and* unordered, since its internal callers only
   * ever filter/iterate. */
  listByProjectPage(
    projectId: string,
    options: { status?: AlignmentThread["status"]; before?: number; limit?: number } = {},
  ): { items: AlignmentThread[]; nextBefore?: number } {
    const limit = Math.min(options.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
    const conditions = [eq(threadsTable.projectId, projectId)];
    if (options.status) conditions.push(eq(threadsTable.status, options.status));
    if (options.before !== undefined) conditions.push(lt(sql`COALESCE(${threadsTable.lastActivityAt}, ${threadsTable.openedAt})`, options.before));
    const rows = this.db
      .select()
      .from(threadsTable)
      .where(and(...conditions))
      .orderBy(sql`COALESCE(${threadsTable.lastActivityAt}, ${threadsTable.openedAt}) DESC, rowid DESC`)
      .limit(limit + 1)
      .all() as ThreadRow[];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(fromRow);
    return { items, nextBefore: hasMore ? items[items.length - 1].lastActivityAt : undefined };
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

  /** Same shape as `postMessage`, author-less -- for a note the coordinator
   * itself is making, not a party replying (2026-08-26). `messages()` reads
   * these back the same way it already does the auto-generated seed note in
   * `findOrCreate` (also author-less, same `alignment_message_posted` kind);
   * `AlignmentMessage.authorId` has been optional for exactly this since
   * that seed note existed, this just gives a second, later-in-the-thread's-
   * life caller the same capability. See `app.ts`'s
   * `notifyAlignmentThreadsOfDecision` for the one caller: resolving a
   * design's block (self-approve or admin-decide) never touched its paired
   * thread at all, so a genuinely-resolved conflict and one nobody ever
   * came back to looked identical from here -- both just sat "open"
   * forever. */
  postSystemMessage(threadId: string, message: string): AlignmentMessage | undefined {
    const thread = this.get(threadId);
    if (!thread) return undefined;
    const ts = Date.now();
    this.activityLog.append({
      projectId: thread.projectId,
      kind: "alignment_message_posted",
      relatedId: threadId,
      ts,
      payload: { message },
    });
    return { message, ts };
  }

  /** Unilateral -- either party can close a thread without the other
   * agreeing; this is advisory, not a negotiation with a required outcome.
   * Idempotent: closing an already-closed thread is a no-op, not a second
   * log entry. `closedBy` is optional (2026-08-27, tightening alignment
   * threads item 3) -- omitted for the coordinator's own auto-close (both
   * parties resolved-or-closed, see app.ts's `maybeAutoCloseThread`), same
   * "author-less" convention `postSystemMessage` above already uses for a
   * note the coordinator itself is making rather than a party. */
  close(threadId: string, closedBy?: string): AlignmentThread | undefined {
    const thread = this.get(threadId);
    if (!thread) return undefined;
    if (thread.status === "closed") return thread;
    const closedAt = Date.now();
    this.db.update(threadsTable).set({ status: "closed", closedAt, closedBy: closedBy ?? null }).where(eq(threadsTable.id, threadId)).run();
    this.activityLog.append({
      projectId: thread.projectId,
      developerId: closedBy,
      kind: "alignment_thread_closed",
      relatedId: threadId,
      ts: closedAt,
    });
    return this.get(threadId);
  }

  /** Reopen-on-new-finding fix (2026-08-28) -- the counterpart to `close()`
   * that its own doc comment used to say didn't exist ("there's no reopen
   * path anywhere in the UI/API for a closed thread", `AlignmentThread`'s
   * doc comment above). Only ever called from `findOrCreate` reacting to a
   * fresh finding that's still actionable (`input.reopenEligible`), never a
   * party's own action -- same "author-less" reasoning as `dormant()`
   * below, so there's no `closedBy`-equivalent identity to record here
   * either. Clears `closedAt`/`closedBy` back to null rather than leaving
   * stale values from the previous close sitting on a now-open thread.
   * No-op if the thread isn't currently `"closed"` (a `"dormant"` thread
   * has its own reopen path, `wake()` below, already reused by
   * `findOrCreate` for that case). */
  reopen(threadId: string): AlignmentThread | undefined {
    const thread = this.get(threadId);
    if (!thread) return undefined;
    if (thread.status !== "closed") return thread;
    this.db.update(threadsTable).set({ status: "open", closedAt: null, closedBy: null }).where(eq(threadsTable.id, threadId)).run();
    this.activityLog.append({
      projectId: thread.projectId,
      kind: "alignment_thread_reopened",
      relatedId: threadId,
      ts: Date.now(),
    });
    return this.get(threadId);
  }

  /** Tightening alignment threads item 4 (2026-08-27): demotes an *open*
   * thread to `"dormant"` -- called only from the design-lifecycle
   * dormancy trigger (`DesignRegistry.sweepExpired`'s `onDesignsWentDormant`
   * hook, reacted to in app.ts), never from a party's own action, so
   * there's no `closedBy`-equivalent identity to record. No-op if the
   * thread isn't currently `"open"` -- an already-closed thread has nothing
   * to demote (closing is the more definitive outcome and always wins),
   * and an already-dormant one is already there. */
  dormant(threadId: string): AlignmentThread | undefined {
    const thread = this.get(threadId);
    if (!thread) return undefined;
    if (thread.status !== "open") return thread;
    this.db.update(threadsTable).set({ status: "dormant" }).where(eq(threadsTable.id, threadId)).run();
    this.activityLog.append({
      projectId: thread.projectId,
      kind: "alignment_thread_dormant",
      relatedId: threadId,
      ts: Date.now(),
    });
    return this.get(threadId);
  }

  /** The symmetric wake-up for `dormant()` above -- `twing design resume`
   * reactivating a design wakes every dormant thread naming it back to
   * `"open"` (see app.ts's resume route), unconditionally: regardless of
   * where the counterpart currently stands, the resumed side coming back
   * makes the conversation relevant again, even if that conversation is
   * now "the other side moved on while you were away." No-op if the thread
   * isn't currently `"dormant"`. */
  wake(threadId: string): AlignmentThread | undefined {
    const thread = this.get(threadId);
    if (!thread) return undefined;
    if (thread.status !== "dormant") return thread;
    this.db.update(threadsTable).set({ status: "open" }).where(eq(threadsTable.id, threadId)).run();
    this.activityLog.append({
      projectId: thread.projectId,
      kind: "alignment_thread_woken",
      relatedId: threadId,
      ts: Date.now(),
    });
    return this.get(threadId);
  }
}
