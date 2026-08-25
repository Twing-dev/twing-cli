/**
 * Drizzle schema (sqlite-core), across four domains -- see the plan this
 * was built from (statefulness redesign, 2026-08) for the full rationale.
 * Ported here in brief since future edits need to preserve it:
 *
 * - User info (identity): mirrors `identity-store.ts`'s prior JSON shape
 *   exactly, just as real tables now.
 * - Unified activity log (`activityEvents`): the first place §4 (Claim/
 *   Finding) and §17 (DesignStatement) intentionally share a table, not
 *   just a data-model family -- see `design-divergence.ts`. Insert-only by
 *   convention: no store method in this codebase issues UPDATE/DELETE
 *   against it.
 * - Running designs: `designs`/`pendingReviews`/`constraints` are ordinary
 *   mutable current-state tables (durable now -- the actual restart bug
 *   this schema fixes), each paired with activity-log entries on every
 *   transition.
 * - Design roadmap: `roadmapItems` is a reserved stub only -- no store
 *   class, no routes, no CLI reference it yet.
 *
 * Claims and CallEdges deliberately do NOT get tables here -- `Store`
 * keeps them in-memory (unchanged; nothing needs a DB-independent
 * current-state read of them, unlike designs), durably represented only as
 * `claim_recorded`/`call_edge_recorded` activity-log rows.
 *
 * Portability discipline for an eventual Postgres driver (see db/client.ts):
 * every column here is `text`/`integer` only (JSON fields are
 * `text`-serialized, epoch-ms timestamps are `integer`, booleans are
 * `integer` 0/1) -- no `sqlite-core`-only column type is load-bearing, so a
 * parallel `pg-core` schema can reuse the same names/shapes later. Nothing
 * in this file uses a SQLite-specific pragma or expression.
 */

import { sqliteTable, text, integer, index, uniqueIndex, primaryKey } from "drizzle-orm/sqlite-core";

// ---------------------------------------------------------------------------
// Identity domain
// ---------------------------------------------------------------------------

export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const orgMemberships = sqliteTable(
  "org_memberships",
  {
    orgId: text("org_id").notNull(),
    developerId: text("developer_id").notNull(),
    role: text("role").notNull(), // "admin" | "member"
  },
  (t) => [primaryKey({ columns: [t.orgId, t.developerId] })],
);

export const projectRecords = sqliteTable("project_records", {
  projectId: text("project_id").primaryKey(),
  // Nullable as of the GitHub-founding path (2026-08-17): a project founded
  // via verified GitHub repo access has no twing Organization at all --
  // access control for it is purely per-project (projectMemberships), since
  // canManageProject/isProjectMember already check direct project
  // membership before ever consulting orgId. Every project founded via the
  // invite/admin-bootstrap path still gets a real orgId, unchanged.
  orgId: text("org_id"),
  foundedBy: text("founded_by").notNull(),
  foundedAt: integer("founded_at").notNull(),
  // §17 Phase 3: nullable, no default (follows designs.agentLabel's
  // precedent) -- absent for every project founded before this shipped, and
  // for any project whose remote isn't GitHub-hosted at all (non-GitHub
  // projects stay invite-only, parked per the plan). Set once, at founding
  // time, from the founder's own canonicalized git remote -- never updated
  // afterward.
  githubOwner: text("github_owner"),
  githubRepo: text("github_repo"),
});

export const projectMemberships = sqliteTable(
  "project_memberships",
  {
    projectId: text("project_id").notNull(),
    developerId: text("developer_id").notNull(),
    role: text("role").notNull(), // "admin" | "member"
  },
  (t) => [primaryKey({ columns: [t.projectId, t.developerId] })],
);

export const developers = sqliteTable("developers", {
  developerId: text("developer_id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: integer("created_at").notNull(),
});

export const invites = sqliteTable("invites", {
  code: text("code").primaryKey(),
  scopeKind: text("scope_kind").notNull(), // "org" | "project"
  scopeOrgId: text("scope_org_id"),
  scopeProjectId: text("scope_project_id"),
  role: text("role").notNull(),
  label: text("label").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  consumedAt: integer("consumed_at"),
  consumedBy: text("consumed_by"),
});

// ---------------------------------------------------------------------------
// Design-gate domain
// ---------------------------------------------------------------------------

export const designs = sqliteTable(
  "designs",
  {
    id: text("id").primaryKey(),
    /** §17 design linking (2026-08): cross-project label, self-assigned to
     * `id` at registration when not supplied -- see `DesignStatement.groupId`'s
     * doc comment (@twing/core) for the full reasoning. Nullable, no
     * backfill for pre-existing rows (this schema's usual "never backfilled"
     * convention -- a pre-migration design just has no group). */
    groupId: text("group_id"),
    projectId: text("project_id").notNull(),
    developerId: text("developer_id").notNull(),
    sessionId: text("session_id").notNull(),
    agentLabel: text("agent_label"),
    status: text("status").notNull(), // "open" | "flagged" | "dormant" | "superseded" | "closed" | "expired"
    /** Set once a justified-divergence review on this design is decided --
     * durable independent of `status` changes afterward (e.g. reopening on
     * approval), so it's a directly-queryable precedent fact rather than
     * something only recoverable by joining `pendingReviews`. */
    reviewDecision: text("review_decision"), // "approve" | "reject" | null
    createdAt: integer("created_at").notNull(),
    closedAt: integer("closed_at"),
    summary: text("summary").notNull(),
    creates: text("creates").notNull(), // JSON string[]
    touches: text("touches").notNull(), // JSON string[]
    dependsOn: text("depends_on").notNull(), // JSON string[]
    rawPlanExcerpt: text("raw_plan_excerpt"),
    ttlMs: integer("ttl_ms").notNull(),
    /** §17 scope enforcement (2026-08): bumped on every `amend`, so the async
     * semantic-comparator loop can detect it's been superseded mid-run. */
    scopeVersion: integer("scope_version").notNull().default(1),
    /** §17 design lifecycle (2026-08): what `ttlMs`/`openDesigns()`/the
     * dormancy sweep are computed from, instead of `createdAt`. Backfilled
     * to `created_at` for pre-existing rows in the migration (see its .sql). */
    lastActivityAt: integer("last_activity_at").notNull(),
    /** §17 review-flow fix (2026-08): constraint ids already settled by an
     * approved review on this exact design -- see DesignStatement's own doc
     * comment (core/types.ts) for why this exists. JSON string[], defaults
     * to "[]" for pre-existing rows via the migration. */
    justifiedConstraintIds: text("justified_constraint_ids").notNull().default("[]"),
    /** Item 7's fix (2026-08-18): structural design-vs-design overlap's
     * counterpart to `justifiedConstraintIds` above -- see
     * `DesignStatement.justifiedOverlaps`'s own doc comment (@twing/core)
     * for the full reasoning. JSON string[] of
     * `${conflictingDesignId}::${path}` keys, defaults to "[]" for
     * pre-existing rows via the migration. */
    justifiedOverlaps: text("justified_overlaps").notNull().default("[]"),
    /** Semantic comparator's counterpart to `justifiedOverlaps` above
     * (2026-08-22) -- see `DesignStatement.justifiedConflicts`'s own doc
     * comment (@twing/core) for the full reasoning. JSON string[] of bare
     * `conflictingDesignId`s (no paths -- a `"conflict"` verdict has none to
     * key on), defaults to "[]" for pre-existing rows via the migration. */
    justifiedConflicts: text("justified_conflicts").notNull().default("[]"),
  },
  (t) => [
    index("designs_project_id_idx").on(t.projectId),
    index("designs_session_id_idx").on(t.sessionId),
    index("designs_group_id_idx").on(t.groupId),
  ],
);

export const pendingReviews = sqliteTable(
  "pending_reviews",
  {
    id: text("id").primaryKey(),
    designId: text("design_id").notNull(),
    projectId: text("project_id").notNull(),
    justification: text("justification").notNull(),
    createdAt: integer("created_at").notNull(),
    decision: text("decision"), // "approve" | "reject" | null
    /** Every constraint this review settles, if it was created against a
     * `constraint_flag` verdict -- see PendingReview's doc comment
     * (core/types.ts). JSON string[], defaults to "[]". Plural
     * (2026-08-22, was a nullable single `constraint_id`) for the same
     * reason `overlapWaivers` below is a list, not a single id: one review
     * can now settle several distinct constraint matches at once. */
    constraintIds: text("constraint_ids").notNull().default("[]"),
    /** Item 7's fix (2026-08-18): the structural overlap(s) this design had
     * against other open designs at justify-time, recomputed fresh rather
     * than trusted from whatever verdict originally flagged it -- same
     * reasoning as `constraintIds` above. JSON
     * `{conflictingDesignId, paths}[]` (a list, not a single id, since one
     * review can span multiple conflicting designs), defaults to "[]". See
     * PendingReview.overlapWaivers. */
    overlapWaivers: text("overlap_waivers").notNull().default("[]"),
    /** Semantic comparator's counterpart to `overlapWaivers` above
     * (2026-08-22) -- set only when this review was created against a
     * `"conflict"` verdict, recorded from the design's current flag rather
     * than recomputed live (a live recheck would mean a second synchronous
     * LLM call inside `/v1/designs/:id/resolve`). JSON
     * `{conflictingDesignId}[]`, defaults to "[]". See
     * PendingReview.conflictWaivers. */
    conflictWaivers: text("conflict_waivers").notNull().default("[]"),
  },
  (t) => [index("pending_reviews_project_id_idx").on(t.projectId)],
);

export const constraints = sqliteTable(
  "constraints",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    type: text("type").notNull(), // DesignConstraintType
    statement: text("statement").notNull(),
    scope: text("scope").notNull(), // JSON string[]
    source: text("source").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("constraints_project_id_idx").on(t.projectId), uniqueIndex("constraints_project_statement_uidx").on(t.projectId, t.statement)],
);

// ---------------------------------------------------------------------------
// Unified activity log -- insert-only by convention
// ---------------------------------------------------------------------------

export const activityEvents = sqliteTable(
  "activity_events",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    developerId: text("developer_id"), // null for system-generated events (e.g. TTL expiry sweep)
    sessionId: text("session_id"),
    kind: text("kind").notNull(),
    relatedId: text("related_id"), // designId / reviewId / threadId, depending on kind
    ts: integer("ts").notNull(),
    payload: text("payload"), // JSON, kind-specific
  },
  (t) => [index("activity_events_project_ts_idx").on(t.projectId, t.ts), index("activity_events_related_id_idx").on(t.relatedId), index("activity_events_kind_idx").on(t.kind)],
);

// ---------------------------------------------------------------------------
// Alignment threads -- current-state table; messages live in activityEvents
// ---------------------------------------------------------------------------

export const alignmentThreads = sqliteTable(
  "alignment_threads",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    // Legacy: the single symbol/design-id-stand-in a thread used to be keyed
    // on (see alignment-store.ts's findOrCreate doc comment) -- kept
    // read-only for pre-2026-08-23 rows; no longer written by new code.
    // `symbolIds` is the source of truth going forward.
    symbolId: text("symbol_id").notNull(),
    developerId: text("developer_id").notNull(), // the claim owner who triggered the divergence
    otherDeveloperId: text("other_developer_id").notNull(), // the open design's owner
    designId: text("design_id"),
    status: text("status").notNull(), // "open" | "closed"
    systemDescription: text("system_description").notNull(),
    openedAt: integer("opened_at").notNull(),
    closedAt: integer("closed_at"),
    closedBy: text("closed_by"),
    // 2026-08-23 alignment-thread redesign (see alignment-store.ts's header
    // comment): category/summary/symbolIds/initiatingDesignId/lastActivityAt
    // are all nullable-or-defaulted so pre-existing rows keep reading
    // correctly -- every new row gets real values, nothing here is backfilled
    // onto old rows.
    category: text("category"), // "duplication" | "contradictory_assumptions" | "tension" | "symbol_claim"
    summary: text("summary"), // short list-view label, distinct from systemDescription's full text
    symbolIds: text("symbol_ids").notNull().default("[]"), // JSON string[] -- every overlapping path accumulated across amendments
    initiatingDesignId: text("initiating_design_id"), // the initiating developer's own open design, when one resolves
    lastActivityAt: integer("last_activity_at"), // bumped on amend; falls back to openedAt when null
  },
  (t) => [index("alignment_threads_project_id_idx").on(t.projectId)],
);

// ---------------------------------------------------------------------------
// Design roadmap -- reserved stub only, no store class/routes/CLI yet
// ---------------------------------------------------------------------------

export const roadmapItems = sqliteTable(
  "roadmap_items",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    summary: text("summary").notNull(),
    status: text("status").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("roadmap_items_project_id_idx").on(t.projectId)],
);
