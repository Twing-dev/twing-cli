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
 * Session captures follow the same "not everything belongs in the DB"
 * discipline from the other direction: `captures` holds only a pointer row,
 * while the conversation itself is appended to a file on disk. A single
 * session's capture is ~1.6MB of append-only text that no query ever filters
 * or joins on, so putting it in a row would grow the database by the size of
 * every conversation ever held while buying nothing SQL is good at.
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
  // Project-level override for DEFAULT_DESIGN_ACTIVE_TTL_MS (2026-09-11),
  // seeded from the repo's committed `.twing/twing.yml` `settings:` block
  // by `twing init` (POST /v1/constraints/seed, the same admin-gated call
  // that seeds constraints) and read once, at design-registration time, in
  // app.ts. Nullable with no default, per this schema's usual convention:
  // absent means "this project never set one," which is what every project
  // founded before this shipped has, and leaves the built-in default in
  // force. Lives on project_records rather than in a settings table of its
  // own because there is exactly one setting -- a table can be introduced
  // later if a second one appears, and this column migrated into it then.
  //
  // Stored per project, not per design. Changing it applies immediately in
  // both directions: designs registered afterward pick it up at
  // registration (app.ts), and designs already open are re-timed in place
  // by DesignRegistry.retimeActiveDesigns. Designs that already went
  // dormant keep their old designs.ttl_ms -- expiry is measured from the
  // active window, so re-timing those would retroactively expire work that
  // went quiet under the previous policy.
  designActiveTtlMs: integer("design_active_ttl_ms"),
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
  // Legacy single-PAT column. Superseded by `developer_tokens` (below),
  // which is what `resolveToken` reads; still written on identity creation
  // so a rollback to the previous release keeps working, and dropped a
  // release after that. Never read for authentication any more.
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: integer("created_at").notNull(),
  // The verified GitHub account behind this identity, when there is one.
  //
  // Keyed on GitHub's **numeric** id, never the login: logins are
  // renameable and reusable, ids are not, so a rename must not look like a
  // different person (and someone taking a freed-up login must not look
  // like the same one). `githubLogin` is display only and is refreshed on
  // every join.
  //
  // Nullable because the invite/`keygen` path never involves GitHub at all
  // -- that is a first-class way to use twing, not a legacy one. Unique
  // because one GitHub account is one identity; the attempt to attach a
  // second is refused rather than silently merged (see `linkGithubAccount`).
  githubUserId: text("github_user_id").unique(),
  githubLogin: text("github_login"),
});

/**
 * One row per credential, so one identity can hold several -- which is the
 * whole point.
 *
 * `developers.token_hash` is `UNIQUE`, i.e. exactly one PAT per person, so a
 * second machine could only ever work by copying the first machine's secret
 * (which is what `twing login --token` does). That made per-machine
 * credentials structurally impossible, and it is the reason a developer
 * could not be onboarded twice without a human moving a secret by hand.
 *
 * `label` names the machine the token was issued to, which is what later
 * makes "revoke that laptop" expressible without revoking the person.
 */
export const developerTokens = sqliteTable(
  "developer_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    developerId: text("developer_id").notNull(),
    label: text("label"),
    createdAt: integer("created_at").notNull(),
  },
  // Authentication looks up by token_hash (the primary key), but revoking a
  // developer deletes every token they hold -- an unindexed scan of a table
  // that grows with machines, not people.
  (t) => [index("developer_tokens_developer_idx").on(t.developerId)],
);

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
    /** `"symbol_conflict"`'s own approval memory (2026-08-26 terminology
     * simplification) -- see `DesignStatement.justifiedSymbolConflicts`'s
     * own doc comment (@twing/core) for why this is a separate field from
     * `justifiedOverlaps` rather than reusing it. JSON string[] of
     * `${conflictingDesignId}::${symbolId}` keys, defaults to "[]". */
    justifiedSymbolConflicts: text("justified_symbol_conflicts").notNull().default("[]"),
    /** Which bucket flagged this design (2026-08-26) -- see
     * `DesignStatement.blockedReason`'s own doc comment (@twing/core) for
     * the full reasoning. Nullable: unset on a design that's never been
     * flagged, and cleared back to null on an approved resolve/`resume()`.
     * No backfill for pre-existing flagged rows (this schema's usual
     * "never backfilled" convention) -- a pre-migration flagged design just
     * has no reason on file until its next flag/resolve cycle. */
    blockedReason: text("blocked_reason"),
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
    /** `"symbol_conflict"`'s counterpart to `overlapWaivers` above
     * (2026-08-26 terminology simplification) -- sourced the same way
     * `conflictWaivers` is: read back from this design's open
     * `category: "symbol_conflict"` alignment threads, not recomputed
     * live. JSON `{conflictingDesignId, symbolIds}[]`, defaults to "[]".
     * See PendingReview.symbolConflictWaivers. */
    symbolConflictWaivers: text("symbol_conflict_waivers").notNull().default("[]"),
  },
  (t) => [
    index("pending_reviews_project_id_idx").on(t.projectId),
    // Change D (2026-08-31, design-gate registration-flow fixes): the
    // `--reassign-project` guard reads "does any pending review reference
    // this design" on every reassignment attempt -- unindexed, this was a
    // full table scan.
    index("pending_reviews_design_id_idx").on(t.designId),
  ],
);

export const constraints = sqliteTable(
  "constraints",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    type: text("type").notNull(), // DesignConstraintType -- collapsed to a single value 2026-08-26, column kept (see the type's own doc comment)
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
    // 2026-08-26 terminology simplification: category collapsed to the two
    // bucket names; the old four values (duplication/contradictory_assumptions/
    // tension/symbol_claim) survive as subKind below, detail under the
    // bucket rather than a competing top-level name. Pre-2026-08-26 rows
    // keep their old category string unconverted -- see AlignmentCategory's
    // own doc comment (alignment-store.ts).
    category: text("category"), // "symbol_conflict" | "llm_divergence" (or a legacy pre-2026-08-26 value)
    subKind: text("sub_kind"), // AlignmentSubKind -- undefined on any row that predates this column
    summary: text("summary"), // short list-view label, distinct from systemDescription's full text
    symbolIds: text("symbol_ids").notNull().default("[]"), // JSON string[] -- every overlapping path accumulated across amendments
    initiatingDesignId: text("initiating_design_id"), // the initiating developer's own open design, when one resolves
    lastActivityAt: integer("last_activity_at"), // bumped on amend; falls back to openedAt when null
  },
  (t) => [
    index("alignment_threads_project_id_idx").on(t.projectId),
    // Change D (2026-08-31): the `--reassign-project` guard also checks
    // both of a design's thread roles (party's own design, and the
    // initiator's) -- same reasoning as pending_reviews_design_id_idx
    // above.
    index("alignment_threads_design_id_idx").on(t.designId),
    index("alignment_threads_initiating_design_id_idx").on(t.initiatingDesignId),
  ],
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

// ---------------------------------------------------------------------------
// Session captures
// ---------------------------------------------------------------------------

/**
 * One row per captured session, pointing at the blob that holds it.
 *
 * Deliberately a pointer, not the content -- see this file's header. The
 * columns here are exactly what a future reader needs to *find* a capture
 * without opening any of them: whose it is, which session, which projects it
 * touched, how big it got, and when it last grew.
 *
 * `projectIds` is a JSON array because a session legitimately spans several
 * opted-in repos, and which one "owns" the capture is an open question this
 * schema deliberately does not answer yet (raw capture first, attribution
 * later). Storing the set keeps every answer available; storing a single
 * winner now would throw away the others irreversibly.
 *
 * No read route, no deletion and no expiry exist yet, so nothing here is
 * indexed for a query that hasn't been designed. The one index is the
 * uniqueness constraint the ingest path itself needs, to find the row to
 * append to.
 */
export const captures = sqliteTable(
  "captures",
  {
    id: text("id").primaryKey(),
    /** Claude Code's own session id, as reported by the capturing daemon. */
    sessionId: text("session_id").notNull(),
    /** Resolved from the authenticated token on every append, never
     * client-supplied -- same rule as every other write in this schema. */
    developerId: text("developer_id").notNull(),
    /** JSON array of twing projectIds, accumulated across appends. */
    projectIds: text("project_ids").notNull(),
    /** Path of the blob, relative to the server's captures directory. */
    blobPath: text("blob_path").notNull(),
    bytes: integer("bytes").notNull(),
    recordCount: integer("record_count").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    // A session's capture arrives incrementally over its whole life, so
    // every append has to land on the same row. Scoped by developer as well
    // as session: session ids come from another process entirely and are
    // never this server's to assume unique across developers.
    developerSession: uniqueIndex("captures_developer_session").on(table.developerId, table.sessionId),
  }),
);
