/**
 * Design registry + constraint store (design doc §17.6). Rewritten onto
 * Drizzle/SQLite in the statefulness redesign (2026-08): both classes were
 * previously TTL-swept-in-memory (`DesignRegistry`) or hand-rolled JSON
 * (`ConstraintStore`); both are now ordinary durable tables, current-state
 * plus one `activity_events` row per transition -- see `db/schema.ts`'s
 * header comment for why this domain gets tables at all (unlike Claims).
 * Public method names/signatures are unchanged from the prior version so
 * `app.ts` and the existing tests barely had to change.
 */

import * as crypto from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  DEFAULT_DESIGN_ACTIVE_TTL_MS,
  DEFAULT_DESIGN_DORMANT_TTL_MS,
  type DesignStatement,
  type DesignConstraint,
  type DesignConstraintType,
  type DesignVerdict,
  type PendingReview,
} from "@twing/core";
import type { Db } from "./db/client.js";
import { designs as designsTable, pendingReviews as reviewsTable, constraints as constraintsTable } from "./db/schema.js";
import { DrizzleActivityLog, type ActivityLogWriter } from "./activity-log.js";
import { mergeDesignScope } from "./design-checks.js";

const SWEEP_INTERVAL_MS = 60_000;

export type NewDesignInput = Omit<
  DesignStatement,
  "id" | "status" | "createdAt" | "closedAt" | "ttlMs" | "reviewDecision" | "scopeVersion" | "lastActivityAt" | "justifiedConstraintIds"
> & {
  ttlMs?: number;
};

interface DesignRow {
  id: string;
  projectId: string;
  developerId: string;
  sessionId: string;
  agentLabel: string | null;
  status: string;
  reviewDecision: string | null;
  createdAt: number;
  closedAt: number | null;
  summary: string;
  creates: string;
  touches: string;
  dependsOn: string;
  rawPlanExcerpt: string | null;
  ttlMs: number;
  scopeVersion: number;
  lastActivityAt: number;
  justifiedConstraintIds: string;
}

function fromDesignRow(row: DesignRow): DesignStatement {
  return {
    id: row.id,
    projectId: row.projectId,
    developerId: row.developerId,
    sessionId: row.sessionId,
    agentLabel: row.agentLabel ?? undefined,
    status: row.status as DesignStatement["status"],
    reviewDecision: (row.reviewDecision as DesignStatement["reviewDecision"]) ?? undefined,
    createdAt: row.createdAt,
    closedAt: row.closedAt ?? undefined,
    summary: row.summary,
    creates: JSON.parse(row.creates),
    touches: JSON.parse(row.touches),
    dependsOn: JSON.parse(row.dependsOn),
    rawPlanExcerpt: row.rawPlanExcerpt ?? undefined,
    ttlMs: row.ttlMs,
    scopeVersion: row.scopeVersion,
    lastActivityAt: row.lastActivityAt,
    justifiedConstraintIds: JSON.parse(row.justifiedConstraintIds),
  };
}

interface ReviewRow {
  id: string;
  designId: string;
  projectId: string;
  justification: string;
  createdAt: number;
  decision: string | null;
  constraintId: string | null;
}

function fromReviewRow(row: ReviewRow): PendingReview {
  return {
    id: row.id,
    designId: row.designId,
    projectId: row.projectId,
    justification: row.justification,
    createdAt: row.createdAt,
    decision: (row.decision as PendingReview["decision"]) ?? undefined,
    constraintId: row.constraintId ?? undefined,
  };
}

export interface DesignRegistryOptions {
  activityLog?: ActivityLogWriter;
}

export class DesignRegistry {
  private db: Db;
  private activityLog: ActivityLogWriter;
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(db: Db, options: DesignRegistryOptions = {}) {
    this.db = db;
    this.activityLog = options.activityLog ?? new DrizzleActivityLog(db);
    this.sweepTimer = setInterval(() => this.sweepExpired(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  stop(): void {
    clearInterval(this.sweepTimer);
  }

  register(input: NewDesignInput): DesignStatement {
    const now = Date.now();
    const design: DesignStatement = {
      ...input,
      id: crypto.randomUUID(),
      status: "open",
      createdAt: now,
      ttlMs: input.ttlMs ?? DEFAULT_DESIGN_ACTIVE_TTL_MS,
      scopeVersion: 1,
      lastActivityAt: now,
      justifiedConstraintIds: [],
    };
    this.db
      .insert(designsTable)
      .values({
        id: design.id,
        projectId: design.projectId,
        developerId: design.developerId,
        sessionId: design.sessionId,
        agentLabel: design.agentLabel ?? null,
        status: design.status,
        reviewDecision: null,
        createdAt: design.createdAt,
        closedAt: null,
        summary: design.summary,
        creates: JSON.stringify(design.creates),
        touches: JSON.stringify(design.touches),
        dependsOn: JSON.stringify(design.dependsOn),
        rawPlanExcerpt: design.rawPlanExcerpt ?? null,
        ttlMs: design.ttlMs,
        scopeVersion: design.scopeVersion,
        lastActivityAt: design.lastActivityAt,
        justifiedConstraintIds: JSON.stringify([] as string[]),
      })
      .run();
    this.activityLog.append({
      projectId: design.projectId,
      developerId: design.developerId,
      sessionId: design.sessionId,
      kind: "design_registered",
      relatedId: design.id,
      ts: design.createdAt,
      payload: { summary: design.summary, creates: design.creates, touches: design.touches, dependsOn: design.dependsOn },
    });
    return design;
  }

  get(id: string): DesignStatement | undefined {
    const row = this.db.select().from(designsTable).where(eq(designsTable.id, id)).get() as DesignRow | undefined;
    return row ? fromDesignRow(row) : undefined;
  }

  /** Every currently-*live* design for a project, excluding a given id (the
   * candidate itself, once registered) -- "live" means `status IN ("open",
   * "flagged")`, not strictly `"open"` (§17 scope enforcement, 2026-08): a
   * flagged/disputed design must stay visible to *other* new registrations'
   * overlap checks, or once one design is flagged that scope becomes
   * invisible to tier-1 detection. `"dormant"` is deliberately *not*
   * included here (§17 design lifecycle, 2026-08) -- that exclusion is the
   * actual fix for unbounded O(n²) pairwise-comparison growth, the entire
   * reason dormancy exists. Callers that need strictly `"open"` (the
   * Edit/Write gate's own-session check, via `/v1/designs/scope-match`) use
   * `listByProject(projectId, "open")` directly instead.
   *
   * The TTL filter is based on `lastActivityAt`, not `createdAt` (§17
   * design lifecycle, 2026-08) -- read-time double-protection matching the
   * periodic sweep below, so a design that's gone stale stops appearing
   * here immediately rather than waiting up to `SWEEP_INTERVAL_MS` for the
   * next sweep tick to physically flip its status. */
  openDesigns(projectId: string, now: number = Date.now(), excludeId?: string): DesignStatement[] {
    const conditions = [
      eq(designsTable.projectId, projectId),
      sql`${designsTable.status} IN ('open', 'flagged')`,
      sql`${designsTable.lastActivityAt} + ${designsTable.ttlMs} > ${now}`,
    ];
    if (excludeId) conditions.push(sql`${designsTable.id} != ${excludeId}`);
    const rows = this.db
      .select()
      .from(designsTable)
      .where(and(...conditions))
      .all() as DesignRow[];
    return rows.map(fromDesignRow);
  }

  /** §17 scope enforcement (2026-08): a design's own registration/amendment
   * verdict wasn't `clean` -- demote it out of "open" so it stops counting
   * as a usable design for the Edit/Write gate, without losing its id
   * (`resolve`/`amend` still address it). No-op (returns the design
   * unchanged) if it isn't currently `"open"`. */
  flag(id: string, verdict: DesignVerdict): DesignStatement | undefined {
    const existing = this.get(id);
    if (!existing || existing.status !== "open") return existing;
    this.db.update(designsTable).set({ status: "flagged" }).where(eq(designsTable.id, id)).run();
    this.activityLog.append({
      projectId: existing.projectId,
      developerId: existing.developerId,
      sessionId: existing.sessionId,
      kind: "design_flagged",
      relatedId: id,
      ts: Date.now(),
      payload: { verdict },
    });
    return this.get(id);
  }

  /** §17 design lifecycle (2026-08): bumps `lastActivityAt` to now, refreshing
   * the active-inactivity clock -- called by `/v1/designs/scope-match` as a
   * side effect of a real `in_scope` hit (a genuine Edit/Write against this
   * exact design's declared scope), so a design that's actually being
   * worked on never goes dormant regardless of how old it is. Silent no-op
   * if the design doesn't exist (nothing meaningful to signal back). */
  touch(id: string): void {
    this.db.update(designsTable).set({ lastActivityAt: Date.now() }).where(eq(designsTable.id, id)).run();
  }

  /** §17 scope enforcement (2026-08): expands an *open* design's declared
   * scope (post-conflict-check -- the caller, `/v1/designs/:id/amend`, is
   * responsible for re-running `runDesignChecks` against the merged shape
   * first and only calling this once that comes back clean). Bumps
   * `scopeVersion` so the async semantic-comparator loop can detect it's
   * been superseded. Returns `undefined` if the design isn't currently
   * `"open"` (flagged/closed/superseded/expired designs can't be amended --
   * resolve or re-register instead). */
  amend(id: string, delta: { touches?: string[]; creates?: string[]; dependsOn?: string[] }): DesignStatement | undefined {
    const existing = this.get(id);
    if (!existing || existing.status !== "open") return undefined;
    const merged = mergeDesignScope(existing, delta);
    const scopeVersion = existing.scopeVersion + 1;
    this.db
      .update(designsTable)
      .set({
        touches: JSON.stringify(merged.touches),
        creates: JSON.stringify(merged.creates),
        dependsOn: JSON.stringify(merged.dependsOn),
        scopeVersion,
        lastActivityAt: Date.now(), // §17 design lifecycle: amending is itself real activity
      })
      .where(eq(designsTable.id, id))
      .run();
    this.activityLog.append({
      projectId: existing.projectId,
      developerId: existing.developerId,
      sessionId: existing.sessionId,
      kind: "design_amended",
      relatedId: id,
      ts: Date.now(),
      payload: { addedTouches: delta.touches ?? [], addedCreates: delta.creates ?? [], addedDependsOn: delta.dependsOn ?? [] },
    });
    return this.get(id);
  }

  /** §17 design lifecycle (2026-08): reactivates a *dormant* design, always
   * as an explicit, deliberate act -- never called silently by a mere file
   * match (see `/v1/designs/scope-match`'s `"dormant"` state and the
   * `twing design resume` CLI command it points at). Cross-developer by
   * design: any project member can pick up a design someone else parked,
   * same as `resolve`/`close` already allow -- so this reassigns both
   * `sessionId` and `developerId` to whoever's resuming it, which is what
   * makes the Edit/Write gate's per-session `scope-match` lookup and future
   * notices/activity attribute correctly to whoever's actually driving now.
   * Original authorship isn't lost -- it's still exactly what the untouched
   * `design_registered` event says, same "current-state row vs. append-only
   * log" split as everywhere else in this domain. Returns `undefined` if
   * the design isn't currently `"dormant"` (the caller, `/v1/designs/:id/
   * resume`, is responsible for re-running `runDesignChecks` against the
   * merged shape first and only calling this once that comes back clean --
   * same contract as `amend`). */
  resume(
    id: string,
    args: { sessionId: string; developerId: string; delta: { touches?: string[]; creates?: string[]; dependsOn?: string[] } },
  ): DesignStatement | undefined {
    const existing = this.get(id);
    if (!existing || existing.status !== "dormant") return undefined;
    const merged = mergeDesignScope(existing, args.delta);
    const now = Date.now();
    this.db
      .update(designsTable)
      .set({
        status: "open",
        sessionId: args.sessionId,
        developerId: args.developerId,
        touches: JSON.stringify(merged.touches),
        creates: JSON.stringify(merged.creates),
        dependsOn: JSON.stringify(merged.dependsOn),
        scopeVersion: existing.scopeVersion + 1,
        lastActivityAt: now,
      })
      .where(eq(designsTable.id, id))
      .run();
    this.activityLog.append({
      projectId: existing.projectId,
      developerId: args.developerId,
      sessionId: args.sessionId,
      kind: "design_resumed",
      relatedId: id,
      ts: now,
      payload: {
        fromDeveloperId: existing.developerId,
        toDeveloperId: args.developerId,
        fromSessionId: existing.sessionId,
        toSessionId: args.sessionId,
      },
    });
    return this.get(id);
  }

  listByProject(projectId: string, status?: DesignStatement["status"]): DesignStatement[] {
    const conditions = [eq(designsTable.projectId, projectId)];
    if (status) conditions.push(eq(designsTable.status, status));
    const rows = this.db
      .select()
      .from(designsTable)
      .where(and(...conditions))
      .all() as DesignRow[];
    return rows.map(fromDesignRow);
  }

  hasOpenForSession(sessionId: string, now: number = Date.now()): boolean {
    const row = this.db
      .select()
      .from(designsTable)
      .where(and(eq(designsTable.sessionId, sessionId), eq(designsTable.status, "open"), sql`${designsTable.createdAt} + ${designsTable.ttlMs} > ${now}`))
      .get();
    return row !== undefined;
  }

  /** §17.5: the agent abandons its own design and adopts the existing one. */
  supersede(id: string): DesignStatement | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const closedAt = Date.now();
    this.db.update(designsTable).set({ status: "superseded", closedAt }).where(eq(designsTable.id, id)).run();
    this.activityLog.append({
      projectId: existing.projectId,
      developerId: existing.developerId,
      sessionId: existing.sessionId,
      kind: "design_resolved",
      relatedId: id,
      ts: closedAt,
      payload: { resolution: "adopted" },
    });
    return this.get(id);
  }

  close(id: string): DesignStatement | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    if (existing.status === "open" || existing.status === "flagged" || existing.status === "dormant") {
      const closedAt = Date.now();
      this.db.update(designsTable).set({ status: "closed", closedAt }).where(eq(designsTable.id, id)).run();
      this.activityLog.append({
        projectId: existing.projectId,
        developerId: existing.developerId,
        sessionId: existing.sessionId,
        kind: "design_closed",
        relatedId: id,
        ts: closedAt,
      });
    }
    return this.get(id);
  }

  /** Best-effort close of every open, flagged, *or dormant* design for a
   * session -- the `SessionEnd` hook trigger (§17.6), a higher-precision
   * substitute for the spec's deferred git-commit-detection trigger.
   * Includes `"flagged"` (§17 scope enforcement, 2026-08) so an abandoned,
   * never-resolved conflicting design doesn't linger past session end, and
   * `"dormant"` (§17 design lifecycle, 2026-08) for the same reason. */
  closeSession(sessionId: string): number {
    const now = Date.now();
    const open = this.db
      .select()
      .from(designsTable)
      .where(and(eq(designsTable.sessionId, sessionId), sql`${designsTable.status} IN ('open', 'flagged', 'dormant')`))
      .all() as DesignRow[];
    for (const row of open) {
      this.db.update(designsTable).set({ status: "closed", closedAt: now }).where(eq(designsTable.id, row.id)).run();
      this.activityLog.append({
        projectId: row.projectId,
        developerId: row.developerId,
        sessionId: row.sessionId,
        kind: "design_closed",
        relatedId: row.id,
        ts: now,
      });
    }
    return open.length;
  }

  addReview(designId: string, projectId: string, justification: string, constraintId?: string): PendingReview {
    const review: PendingReview = { id: crypto.randomUUID(), designId, projectId, justification, createdAt: Date.now(), constraintId };
    this.db
      .insert(reviewsTable)
      .values({
        id: review.id,
        designId: review.designId,
        projectId: review.projectId,
        justification: review.justification,
        createdAt: review.createdAt,
        decision: null,
        constraintId: constraintId ?? null,
      })
      .run();
    this.activityLog.append({
      projectId,
      kind: "review_created",
      relatedId: review.id,
      ts: review.createdAt,
      payload: { designId, justification, constraintId },
    });
    return review;
  }

  getReview(id: string): PendingReview | undefined {
    const row = this.db.select().from(reviewsTable).where(eq(reviewsTable.id, id)).get() as ReviewRow | undefined;
    return row ? fromReviewRow(row) : undefined;
  }

  listReviews(projectId: string, pendingOnly = true): PendingReview[] {
    const conditions = [eq(reviewsTable.projectId, projectId)];
    if (pendingOnly) conditions.push(isNull(reviewsTable.decision));
    const rows = this.db
      .select()
      .from(reviewsTable)
      .where(and(...conditions))
      .all() as ReviewRow[];
    return rows.map(fromReviewRow);
  }

  /** `/v1/designs/scope-match`'s "flagged" state needs this to tell "you
   * never resolved this" apart from "you resolved it, an admin just
   * hasn't decided yet" -- both looked identical to a retrying Edit/Write
   * before this (found live, 2026-08-16): the deny message told you to run
   * `twing design resolve` even after you already had, with no signal a
   * review was actually pending. */
  hasPendingReview(designId: string): boolean {
    const row = this.db
      .select()
      .from(reviewsTable)
      .where(and(eq(reviewsTable.designId, designId), isNull(reviewsTable.decision)))
      .get();
    return row !== undefined;
  }

  /** §17.5: approving a divergence reopens the design as a second valid
   * canonical path -- it does not itself write a new constraint (spec §7
   * step 5 leaves that optional; not implemented here to keep this pass
   * narrow). Either way, the decision is stamped onto the design's own
   * `reviewDecision` field -- durable precedent independent of whatever
   * `status` does next (statefulness redesign, 2026-08). */
  decideReview(id: string, decision: "approve" | "reject"): PendingReview | undefined {
    const review = this.getReview(id);
    if (!review) return undefined;
    this.db.update(reviewsTable).set({ decision }).where(eq(reviewsTable.id, id)).run();
    // Approve reopens the design as a second valid canonical path (unchanged).
    // Reject (§17 scope enforcement, 2026-08 -- previously left `status`
    // untouched, so a rejected design just stayed "flagged" forever with
    // nothing ever consulting `reviewDecision`) now makes the rejection
    // terminal: the design closes, the developer registers a fresh one.
    //
    // §17 review-flow fix (2026-08): an approval that settles a specific
    // constraint match also appends its id to justifiedConstraintIds, so
    // runDesignChecks stops re-flagging *this exact* constraint on future
    // amends -- see justifiedConstraintIds' own doc comment (core/types.ts).
    // Only on approve; a rejected review settles nothing.
    const design = this.get(review.designId);
    const justifiedConstraintIds =
      decision === "approve" && review.constraintId && design && !design.justifiedConstraintIds.includes(review.constraintId)
        ? [...design.justifiedConstraintIds, review.constraintId]
        : undefined;
    this.db
      .update(designsTable)
      .set({
        reviewDecision: decision,
        ...(decision === "approve" ? { status: "open" } : { status: "closed", closedAt: Date.now() }),
        ...(justifiedConstraintIds ? { justifiedConstraintIds: JSON.stringify(justifiedConstraintIds) } : {}),
      })
      .where(eq(designsTable.id, review.designId))
      .run();
    this.activityLog.append({
      projectId: review.projectId,
      kind: "review_decided",
      relatedId: id,
      ts: Date.now(),
      payload: { designId: review.designId, decision },
    });
    return this.getReview(id);
  }

  /** Two-stage sweep (§17 design lifecycle, 2026-08 -- previously a single
   * open/flagged-straight-to-expired pass keyed off `createdAt`):
   *
   * 1. `"open"`/`"flagged"` designs with no activity for `ttlMs` demote to
   *    `"dormant"` -- not closed, still fully addressable
   *    (`resolve`/`amend`/`resume`), just excluded from `openDesigns()`'s
   *    pairwise-comparison set. This is the actual n² fix.
   * 2. `"dormant"` designs with no activity for
   *    `DEFAULT_DESIGN_DORMANT_TTL_MS` terminally expire, same as before.
   *
   * Both stages key off `lastActivityAt`, not `createdAt` -- genuinely
   * active work never dies just for being old.
   *
   * Public (unlike the pre-lifecycle version) and takes an injectable `now`
   * -- same reason `openDesigns` already does: lets tests exercise real
   * TTL-elapsed transitions without waiting out `SWEEP_INTERVAL_MS` or
   * mocking `Date.now()` globally. The constructor's interval timer still
   * calls this the normal way, with no `now` override. */
  sweepExpired(now: number = Date.now()): void {
    const goingDormant = this.db
      .select()
      .from(designsTable)
      .where(and(sql`${designsTable.status} IN ('open', 'flagged')`, sql`${designsTable.lastActivityAt} + ${designsTable.ttlMs} <= ${now}`))
      .all() as DesignRow[];
    for (const row of goingDormant) {
      this.db.update(designsTable).set({ status: "dormant" }).where(eq(designsTable.id, row.id)).run();
      this.activityLog.append({
        projectId: row.projectId,
        developerId: row.developerId,
        sessionId: row.sessionId,
        kind: "design_dormant",
        relatedId: row.id,
        ts: now,
      });
    }

    const expiring = this.db
      .select()
      .from(designsTable)
      .where(and(eq(designsTable.status, "dormant"), sql`${designsTable.lastActivityAt} + ${DEFAULT_DESIGN_DORMANT_TTL_MS} <= ${now}`))
      .all() as DesignRow[];
    for (const row of expiring) {
      this.db.update(designsTable).set({ status: "expired", closedAt: now }).where(eq(designsTable.id, row.id)).run();
      this.activityLog.append({
        projectId: row.projectId,
        sessionId: row.sessionId,
        kind: "design_expired",
        relatedId: row.id,
        ts: now,
      });
    }
  }
}

interface ConstraintRow {
  id: string;
  projectId: string;
  type: string;
  statement: string;
  scope: string;
  source: string;
  createdAt: number;
}

function fromConstraintRow(row: ConstraintRow): DesignConstraint {
  return {
    id: row.id,
    projectId: row.projectId,
    type: row.type as DesignConstraintType,
    statement: row.statement,
    scope: JSON.parse(row.scope),
    source: row.source,
    createdAt: row.createdAt,
  };
}

export interface ConstraintStoreOptions {
  activityLog?: ActivityLogWriter;
}

export class ConstraintStore {
  private db: Db;
  private activityLog: ActivityLogWriter;

  constructor(db: Db, options: ConstraintStoreOptions = {}) {
    this.db = db;
    this.activityLog = options.activityLog ?? new DrizzleActivityLog(db);
  }

  forProject(projectId: string): DesignConstraint[] {
    const rows = this.db.select().from(constraintsTable).where(eq(constraintsTable.projectId, projectId)).all() as ConstraintRow[];
    return rows.map(fromConstraintRow);
  }

  /** Idempotent upsert keyed by (projectId, statement) -- used both by the
   * cold-start seed (`twing init` -> `POST /v1/constraints/seed`, §17.2)
   * and by future ratification of a resolved divergence.
   *
   * Updates scope/type on an existing match instead of returning it
   * unchanged (fixed live, 2026-08-16): before this, narrowing or widening
   * an existing constraint's scope in the committed `.twing/twing.yml` and
   * re-running `twing init` had *no effect at all* -- the upsert matched
   * on statement text alone and handed back the stale row regardless of
   * what scope/type the caller just asked to seed, so the local file
   * stopped being source-of-truth the moment anyone edited an existing
   * entry rather than adding a new one. */
  add(projectId: string, statement: string, scope: string[], type: DesignConstraintType, source: string): DesignConstraint {
    const existingRow = this.db
      .select()
      .from(constraintsTable)
      .where(and(eq(constraintsTable.projectId, projectId), eq(constraintsTable.statement, statement)))
      .get() as ConstraintRow | undefined;
    if (existingRow) {
      const existing = fromConstraintRow(existingRow);
      const scopeUnchanged = JSON.stringify(existing.scope) === JSON.stringify(scope);
      if (scopeUnchanged && existing.type === type) return existing;

      this.db.update(constraintsTable).set({ scope: JSON.stringify(scope), type }).where(eq(constraintsTable.id, existing.id)).run();
      const updated: DesignConstraint = { ...existing, scope, type };
      this.activityLog.append({
        projectId,
        kind: "constraint_updated",
        relatedId: existing.id,
        ts: Date.now(),
        payload: { statement, type, scope, previousScope: existing.scope, previousType: existing.type, source },
      });
      return updated;
    }

    const constraint: DesignConstraint = { id: crypto.randomUUID(), projectId, type, statement, scope, source, createdAt: Date.now() };
    this.db
      .insert(constraintsTable)
      .values({
        id: constraint.id,
        projectId: constraint.projectId,
        type: constraint.type,
        statement: constraint.statement,
        scope: JSON.stringify(constraint.scope),
        source: constraint.source,
        createdAt: constraint.createdAt,
      })
      .run();
    this.activityLog.append({
      projectId,
      kind: "constraint_ratified",
      relatedId: constraint.id,
      ts: constraint.createdAt,
      payload: { statement, type, source },
    });
    return constraint;
  }
}
