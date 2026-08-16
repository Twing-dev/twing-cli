/**
 * `twing serve` — the coordination server (§7). Access control is
 * per-developer PATs (§17.10 hardening) resolved through `IdentityStore`:
 * every `/v1/*` route (barring the two exemptions noted at the auth
 * middleware below) requires a valid bearer token, and `developerId` is
 * always the authenticated identity, never a client-supplied field --
 * that's the actual fix for the "anyone can claim to be anyone" gap this
 * replaces. `Organization`/`ProjectMembership` roles gate who can do what;
 * see `identity-store.ts`'s header comment for the three trust boundaries.
 */

import { Hono } from "hono";
import type { Claim, CallEdge, DesignStatement, DesignConstraintType, Finding } from "@twing/core";
import { type Db, createDb } from "./db/client.js";
import { Store } from "./store.js";
import { runChecks } from "./checks.js";
import { DesignRegistry, ConstraintStore } from "./design-store.js";
import { runDesignChecks, matchConstraintsForPaths, pathInDesignScope, mergeDesignScope } from "./design-checks.js";
import { extractDesign } from "./design-extract.js";
import type { LlmProvider } from "./llm-client.js";
import { checkSemanticConflict } from "./design-semantic-check.js";
import { findDesignDivergences } from "./design-divergence.js";
import { AlignmentThreadStore } from "./alignment-store.js";
import { DrizzleActivityLog } from "./activity-log.js";
import { IdentityStore, type ResolvedIdentity, type InviteScope, type Role } from "./identity-store.js";

interface ClaimsRequestBody {
  projectId?: string;
  claims?: Claim[];
  callEdges?: CallEdge[];
}

// §17.2's single check endpoint accepts either rawPlanText (extraction runs
// server-side) or pre-structured fields (agent-supplied, extraction skipped).
// developerId is deliberately not part of this shape -- resolved from the
// authenticated identity instead (§17.10 hardening).
interface DesignCheckRequestBody {
  projectId?: string;
  sessionId?: string;
  agentLabel?: string;
  rawPlanText?: string;
  creates?: string[];
  touches?: string[];
  dependsOn?: string[];
  summary?: string;
  ttlMs?: number;
}

interface ResolveRequestBody {
  resolution?: "adopted" | "justified_divergence";
  adoptedDesignId?: string;
  justification?: string;
}

// §17 scope enforcement (2026-08): "add" fields only -- amend expands an
// open design's declared scope, it never removes from it.
interface AmendRequestBody {
  addTouches?: string[];
  addCreates?: string[];
  addDependsOn?: string[];
}

// §17 design lifecycle (2026-08): sessionId is required -- resume
// reassigns the design to whoever's calling this, so the gate's
// per-session scope-match lookup works for them afterward. Scope delta is
// optional, unlike amend's (resuming with no new files is a valid call).
interface ResumeRequestBody {
  sessionId?: string;
  addTouches?: string[];
  addCreates?: string[];
  addDependsOn?: string[];
}

interface SeedRequestBody {
  projectId?: string;
  constraints?: { statement: string; scope: string[]; type?: DesignConstraintType }[];
}

interface BootstrapRequestBody {
  bootstrapToken?: string;
  tokenHash?: string;
  label?: string;
  orgName?: string;
}

interface InviteRequestBody {
  label?: string;
  role?: Role;
  orgId?: string;
}

interface RedeemRequestBody {
  tokenHash?: string;
  label?: string;
}

export interface CreateAppOptions {
  /** Shared Drizzle handle every store below is built from -- pass one
   * explicitly to share a single database across a test; otherwise built
   * from `dataDir` (statefulness redesign, 2026-08). */
  db?: Db;
  /** Only consulted when `db` isn't supplied directly, and by `identities`
   * for its bootstrap-token file (which stays a plaintext file regardless
   * of the DB, see identity-store.ts's header comment). */
  dataDir?: string;
  store?: Store;
  designs?: DesignRegistry;
  constraints?: ConstraintStore;
  identities?: IdentityStore;
  alignmentThreads?: AlignmentThreadStore;
  extractModel?: string;
  /** Defaults to "openrouter" -- see llm-client.ts's provider seam. */
  extractProvider?: LlmProvider;
  openRouterApiKey?: string;
  /** design-semantic-check.ts's model -- always Bedrock (see that file's
   * header comment), defaults to the model this repo's own eval settled on. */
  semanticCheckModel?: string;
}

const RAW_PLAN_EXCERPT_CHARS = 2000;

type Variables = { identity: ResolvedIdentity };

export function createApp(options: CreateAppOptions = {}) {
  const db = options.db ?? createDb({ dataDir: options.dataDir });
  const store = options.store ?? new Store(db);
  const designs = options.designs ?? new DesignRegistry(db);
  const constraintStore = options.constraints ?? new ConstraintStore(db);
  const identities = options.identities ?? new IdentityStore(db, { dataDir: options.dataDir });
  const alignmentThreads = options.alignmentThreads ?? new AlignmentThreadStore(db);
  const activityLog = new DrizzleActivityLog(db);
  const extractModel = options.extractModel ?? "openai/gpt-oss-20b:free";
  const extractProvider = options.extractProvider ?? "openrouter";
  const openRouterApiKey = options.openRouterApiKey;
  const semanticCheckModel = options.semanticCheckModel ?? "google.gemma-4-31b";

  const app = new Hono<{ Variables: Variables }>();

  // §17.10: every /v1/* route requires a valid bearer PAT, except the two
  // that can't assume one exists yet -- bootstrap (nobody has a PAT before
  // their first one) and invite redemption (works both authenticated, for
  // an existing developer joining a second org/project, and unauthenticated,
  // for a brand-new developer redeeming with a freshly-generated token).
  app.use("/v1/*", async (c, next) => {
    if (c.req.path === "/v1/admin/bootstrap") return next();
    if (/^\/v1\/invites\/[^/]+\/redeem$/.test(c.req.path)) return next();
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    const identity = token ? identities.resolveToken(token) : undefined;
    if (!identity) {
      return c.json({ error: "unauthorized -- run `twing login --token <pat>` (or `twing keygen --invite <code>` if you don't have one yet)" }, 401);
    }
    c.set("identity", identity);
    return next();
  });

  app.get("/", (c) => c.text("twing serve"));

  // §17.10: who am I, and what am I a member of -- what `twing whoami` and
  // `twing login`'s validation step both call.
  app.get("/v1/auth/whoami", (c) => c.json(c.get("identity")));

  // Break-glass: the one-time bootstrap token (never a human-chosen
  // password) authorizes creating the first org + its admin. The
  // developer's own PAT is still generated client-side (`tokenHash`) --
  // the bootstrap token only proves "I'm allowed to do this," it isn't
  // itself the credential used afterward.
  app.post("/v1/admin/bootstrap", async (c) => {
    const body = await c.req.json<BootstrapRequestBody>().catch(() => null);
    if (!body || !body.bootstrapToken || !body.tokenHash || !body.label) {
      return c.json({ error: "expected { bootstrapToken, tokenHash, label, orgName? }" }, 400);
    }
    const result = identities.bootstrap(body.bootstrapToken, body.tokenHash, body.label, body.orgName);
    if ("error" in result) return c.json(result, 400);
    console.log(`twing serve: bootstrapped org ${result.orgId.slice(0, 8)} with admin ${result.developerId}`);
    return c.json(result);
  });

  /** Resolves which org an admin-scoped action applies to: explicit
   * `orgId` if the caller is admin of it, else their first admin org (v1
   * only ever has one). */
  function resolveAdminOrg(identity: ResolvedIdentity, requestedOrgId?: string): string | undefined {
    const adminOrgIds = identity.orgs.filter((o) => o.role === "admin").map((o) => o.orgId);
    if (requestedOrgId) return adminOrgIds.includes(requestedOrgId) ? requestedOrgId : undefined;
    return adminOrgIds[0];
  }

  app.post("/v1/admin/invites", async (c) => {
    const identity = c.get("identity");
    const body = await c.req.json<InviteRequestBody>().catch(() => null);
    if (!body || !body.label) return c.json({ error: "expected { label, role?, orgId? }" }, 400);
    const orgId = resolveAdminOrg(identity, body.orgId);
    if (!orgId) return c.json({ error: "not an admin of that organization" }, 403);
    const invite = identities.createInvite({ kind: "org", orgId }, body.role ?? "member", body.label, identity.developerId);
    return c.json({ code: invite.code, expiresAt: invite.expiresAt });
  });

  app.get("/v1/admin/invites", (c) => {
    const identity = c.get("identity");
    const orgId = resolveAdminOrg(identity, c.req.query("orgId"));
    if (!orgId) return c.json({ error: "not an admin of that organization" }, 403);
    return c.json({ items: identities.listInvites({ kind: "org", orgId }) });
  });

  app.get("/v1/admin/developers", (c) => {
    const identity = c.get("identity");
    const orgId = resolveAdminOrg(identity, c.req.query("orgId"));
    if (!orgId) return c.json({ error: "not an admin of that organization" }, 403);
    return c.json({ items: identities.listOrgMembers(orgId) });
  });

  app.post("/v1/admin/developers/:id/revoke", (c) => {
    const identity = c.get("identity");
    const targetId = c.req.param("id");
    // Any org the caller admins that the target also belongs to authorizes the revoke.
    const callerAdminOrgs = identity.orgs.filter((o) => o.role === "admin").map((o) => o.orgId);
    const authorized = callerAdminOrgs.some((orgId) => identities.listOrgMembers(orgId).some((m) => m.developerId === targetId));
    if (!authorized) return c.json({ error: "not authorized to revoke this developer" }, 403);
    const revoked = identities.revokeDeveloper(targetId);
    if (!revoked) return c.json({ error: "no such developer" }, 404);
    return c.json({ status: "revoked" });
  });

  function projectOrgId(projectId: string): string | undefined {
    return identities.getProjectRecord(projectId)?.orgId;
  }

  function canManageProject(identity: ResolvedIdentity, projectId: string): boolean {
    if (identity.projects.some((p) => p.projectId === projectId && p.role === "admin")) return true;
    const orgId = projectOrgId(projectId);
    return orgId !== undefined && identity.orgs.some((o) => o.orgId === orgId && o.role === "admin");
  }

  app.post("/v1/projects/:id/invites", async (c) => {
    const identity = c.get("identity");
    const projectId = c.req.param("id");
    if (!canManageProject(identity, projectId)) return c.json({ error: "not an admin of this project" }, 403);
    const body = await c.req.json<InviteRequestBody>().catch(() => null);
    if (!body || !body.label) return c.json({ error: "expected { label, role? }" }, 400);
    const invite = identities.createInvite({ kind: "project", projectId }, body.role ?? "member", body.label, identity.developerId);
    return c.json({ code: invite.code, expiresAt: invite.expiresAt });
  });

  app.get("/v1/projects/:id/invites", (c) => {
    const identity = c.get("identity");
    const projectId = c.req.param("id");
    if (!canManageProject(identity, projectId)) return c.json({ error: "not an admin of this project" }, 403);
    return c.json({ items: identities.listInvites({ kind: "project", projectId }) });
  });

  app.delete("/v1/invites/:code", (c) => {
    const identity = c.get("identity");
    const invite = identities.getInvite(c.req.param("code"));
    if (!invite) return c.json({ error: "no such invite" }, 404);
    const scope = invite.scope;
    const authorized =
      scope.kind === "org" ? identity.orgs.some((o) => o.orgId === scope.orgId && o.role === "admin") : canManageProject(identity, scope.projectId);
    if (!authorized) return c.json({ error: "not authorized to revoke this invite" }, 403);
    identities.revokeInvite(invite.code);
    return c.json({ status: "revoked" });
  });

  app.get("/v1/projects/:id/developers", (c) => {
    const identity = c.get("identity");
    const projectId = c.req.param("id");
    if (!identity.projects.some((p) => p.projectId === projectId)) return c.json({ error: "not a member of this project" }, 403);
    return c.json({ items: identities.listProjectMembers(projectId) });
  });

  app.delete("/v1/projects/:id/developers/:developerId", (c) => {
    const identity = c.get("identity");
    const projectId = c.req.param("id");
    if (!canManageProject(identity, projectId)) return c.json({ error: "not an admin of this project" }, 403);
    const removed = identities.removeProjectMember(projectId, c.req.param("developerId"));
    if (!removed) return c.json({ error: "no such member" }, 404);
    return c.json({ status: "removed" });
  });

  // Works both authenticated (an existing developer joining a second
  // org/project with their already-cached PAT -- no new keygen needed) and
  // unauthenticated (a brand-new developer presenting a freshly-generated
  // token's hash). The plaintext token itself never reaches this route
  // either way -- only its hash, generated client-side.
  app.post("/v1/invites/:code/redeem", async (c) => {
    const code = c.req.param("code");
    const header = c.req.header("authorization") ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    const existing = bearer ? identities.resolveToken(bearer) : undefined;

    let result;
    if (existing) {
      result = identities.redeemInvite(code, { developerId: existing.developerId });
    } else {
      const body = await c.req.json<RedeemRequestBody>().catch(() => null);
      if (!body || !body.tokenHash || !body.label) {
        return c.json({ error: "expected { tokenHash, label } when not already authenticated" }, 400);
      }
      result = identities.redeemInvite(code, { tokenHash: body.tokenHash, label: body.label });
    }
    if ("error" in result) return c.json(result, 400);
    console.log(`twing serve: invite ${code.slice(0, 8)} redeemed by ${result.developerId}`);
    return c.json(result);
  });

  /** §boundary 1/3: reject a projectId the authenticated developer isn't a
   * member of, except founding it for the first time. This is where the
   * trust boundaries actually bind operationally -- the admin/invite
   * endpoints alone don't enforce anything by themselves. */
  function authorizeProject(identity: ResolvedIdentity, projectId: string): { ok: true } | { ok: false; status: 403; error: string } {
    if (identity.projects.some((p) => p.projectId === projectId)) return { ok: true };
    if (!identities.isProjectFounded(projectId)) {
      const founded = identities.foundProject(projectId, identity.developerId);
      if ("error" in founded) return { ok: false, status: 403, error: founded.error };
      identity.projects.push({ projectId, orgId: founded.orgId, role: "admin" });
      return { ok: true };
    }
    return { ok: false, status: 403, error: `not a member of project ${projectId}` };
  }

  /**
   * Async semantic-conflict comparator (design-semantic-check.ts, 2026-08):
   * called unawaited so it never delays the response that triggered it --
   * runs unconditionally against every currently-live design regardless of
   * the syntactic verdict. Deliberately not gated on a syntactic hit:
   * neither the deny payload a gated Edit/Write sees nor the
   * justified-divergence review flow ever surfaces a design's full raw
   * text (just `summary` + a narrow `overlapDetail` string), so a syntactic
   * `overlap` doesn't guarantee a human would ever see a deeper, un-flagged
   * issue in the same pair. Mirrors the findDesignDivergences pipeline in
   * POST /v1/claims below almost exactly -- same alignment-thread/notice/
   * activity-log shape.
   *
   * Shared by both initial registration and `amend` (§17 scope enforcement,
   * 2026-08): `amend` bumps `scopeVersion` before calling this, so a stale
   * pass from a *prior* call (registration or an earlier amend) that's
   * still mid-loop cooperatively stops issuing further comparisons the next
   * time it re-reads the design -- "kill" without aborting an in-flight
   * HTTP call, "retain the findings" because activity_events/alignment
   * threads are append-only and nothing here ever retracts a past one.
   */
  function runSemanticComparatorPass(candidateId: string, others: DesignStatement[]): void {
    const started = designs.get(candidateId);
    if (!started) return;
    const startVersion = started.scopeVersion;
    void (async () => {
      for (const other of others) {
        const current = designs.get(candidateId);
        if (!current || current.scopeVersion !== startVersion) return; // superseded by a later amend -- stop
        const result = await checkSemanticConflict(current, other, { model: semanticCheckModel });
        if (!result.conflict) continue;
        const thread = alignmentThreads.findOrCreate({
          projectId: current.projectId,
          symbolId: current.id, // stand-in dedup key -- no real symbolId for a design-vs-design finding
          developerId: current.developerId,
          otherDeveloperId: other.developerId,
          designId: other.id,
          systemDescription: result.reason,
          ts: Date.now(),
        });
        activityLog.append({
          projectId: current.projectId,
          developerId: current.developerId,
          kind: "design_semantic_conflict",
          relatedId: thread.id,
          ts: Date.now(),
          payload: { otherDesignId: other.id, kind: result.kind, reason: result.reason },
        });
        store.addNotice(current.developerId, result.reason, Date.now(), thread.id);
        store.addNotice(other.developerId, result.reason, Date.now(), thread.id);
      }
    })().catch((err) => console.error("twing serve: semantic conflict check failed", err));
  }

  /** Shared by `/v1/designs/:id/amend` and `/v1/designs/:id/resume`: builds
   * the merged-scope candidate and runs the full syntactic check
   * (design-checks.ts tiers 1-3) against whatever's currently live, exactly
   * like initial registration does -- neither route can be used to
   * silently launder a scope change past overlap/constraint detection.
   * Callers persist (`designs.amend`/`designs.resume`) only on a clean
   * verdict; `open` is returned too since a clean persist also needs it for
   * `runSemanticComparatorPass`. */
  function checkAmendedScope(design: DesignStatement, delta: { touches?: string[]; creates?: string[]; dependsOn?: string[] }) {
    const merged = mergeDesignScope(design, delta);
    const candidate: DesignStatement = { ...design, ...merged };
    const open = designs.openDesigns(design.projectId, Date.now(), design.id);
    const constraints = constraintStore.forProject(design.projectId);
    const outcome = runDesignChecks(candidate, open, constraints);
    return { outcome, open };
  }

  // §7: upserts claims + call-graph edges for projectId, runs the
  // divergence checks against everything active in the project, and
  // returns findings involving the just-submitted claims. Every claim's
  // developerId is stamped with the authenticated identity -- whatever a
  // client sent is ignored, not merely validated.
  app.post("/v1/claims", async (c) => {
    const identity = c.get("identity");
    const body = await c.req.json<ClaimsRequestBody>().catch(() => null);
    if (!body || typeof body.projectId !== "string" || !Array.isArray(body.claims)) {
      return c.json({ error: "expected { projectId: string, claims: Claim[], callEdges?: CallEdge[] }" }, 400);
    }
    const authz = authorizeProject(identity, body.projectId);
    if (!authz.ok) return c.json({ error: authz.error }, authz.status);

    const projectId = body.projectId;
    const claims = body.claims.map((claim) => ({ ...claim, developerId: identity.developerId }));
    const callEdges = body.callEdges ?? [];

    const changed = store.upsert(projectId, claims, callEdges);
    const active = store.activeClaims(projectId);
    const edges = store.callEdgesFor(projectId);
    const findings = runChecks(changed, active, edges);

    // Cross-session design divergence (statefulness redesign, 2026-08): the
    // first place a real Claim is checked against another session's
    // self-reported open DesignStatement, not just against other designs'
    // self-reported fields. Advisory only, same as every other finding here
    // -- never a deny. Each match opens/reuses a persistent alignment
    // thread (dedup handled by AlignmentThreadStore.findOrCreate) so both
    // parties can reconcile asynchronously; the thread's id rides along on
    // the Finding/Notice so `twing align respond` has something to point at.
    const divergences = findDesignDivergences(changed, designs.openDesigns(projectId));
    const divergenceFindings: Finding[] = divergences.map(({ finding, design }) => {
      const thread = alignmentThreads.findOrCreate({
        projectId,
        symbolId: finding.symbolId,
        developerId: finding.developerId,
        otherDeveloperId: finding.otherDeveloperId,
        designId: design.id,
        systemDescription: finding.reason,
        ts: finding.ts,
      });
      return { ...finding, threadId: thread.id };
    });

    const allFindings = [...findings, ...divergenceFindings];

    console.log(
      `twing serve: project ${projectId.slice(0, 12)} -- received ${claims.length} claim(s), ${callEdges.length} edge(s) ` +
        `(${changed.length} new/changed) -> ${allFindings.length} finding(s)`,
    );
    for (const f of allFindings) {
      console.log(`twing serve:   [${f.kind}] ${f.symbolId} -- ${f.developerId} <-> ${f.otherDeveloperId}`);
      activityLog.append({
        projectId: f.projectId,
        developerId: f.developerId,
        kind: "finding_raised",
        relatedId: f.threadId,
        ts: f.ts,
        payload: { kind: f.kind, symbolId: f.symbolId, otherDeveloperId: f.otherDeveloperId, reason: f.reason },
      });
    }

    // Deliver to both parties: the submitter gets it synchronously here too
    // (redundant with this response but keeps the daemon's poll loop
    // uniform — it always just reads notices), and the other party learns
    // of it asynchronously on their next poll (§7).
    for (const f of allFindings) {
      store.addNotice(f.developerId, f.reason, f.ts, f.threadId);
      store.addNotice(f.otherDeveloperId, f.reason, f.ts, f.threadId);
    }

    return c.json({ findings: allFindings });
  });

  // §7: findings generated after the daemon's last push, including ones
  // triggered by another developer's later activity. Scoped to the
  // authenticated identity -- no longer an arbitrary query param, so one
  // developer can't read another's notices.
  app.get("/v1/notices", (c) => {
    const identity = c.get("identity");
    const since = Number(c.req.query("since") ?? "0");
    const items = store.noticesSince(identity.developerId, Number.isFinite(since) ? since : 0);
    // Silent when empty -- this is polled every few seconds per developer
    // (§5), and an empty result is the overwhelmingly common, boring case.
    if (items.length > 0) {
      console.log(`twing serve: delivering ${items.length} notice(s) to ${identity.developerId}`);
    }
    return c.json({ items });
  });

  /** Membership check shared by all four alignment-thread routes below:
   * only the two parties on a thread (never a bystander, even a project
   * admin) can read/reply/close it -- this is a private, voluntary
   * reconciliation channel between the two developers it names, not a
   * project-wide one. */
  function isThreadParty(identity: ResolvedIdentity, thread: { developerId: string; otherDeveloperId: string }): boolean {
    return identity.developerId === thread.developerId || identity.developerId === thread.otherDeveloperId;
  }

  // Alignment threads (statefulness redesign, 2026-08): the async,
  // never-blocking "conversation layer" for a design_divergence finding
  // (design-divergence.ts). Purely additive to the notice pipeline above --
  // no PreToolUse/deny semantics anywhere on this path, and hook/design_gate.go
  // needs no changes for any of these.
  app.get("/v1/alignment-threads", (c) => {
    const identity = c.get("identity");
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "expected ?projectId=" }, 400);
    if (!identity.projects.some((p) => p.projectId === projectId)) {
      return c.json({ error: "not a member of this project" }, 403);
    }
    const status = c.req.query("status") as "open" | "closed" | undefined;
    const items = alignmentThreads.listByProject(projectId, status).filter((t) => isThreadParty(identity, t));
    return c.json({ items });
  });

  app.get("/v1/alignment-threads/:id", (c) => {
    const identity = c.get("identity");
    const thread = alignmentThreads.get(c.req.param("id"));
    if (!thread) return c.json({ error: "no such thread" }, 404);
    if (!isThreadParty(identity, thread)) return c.json({ error: "not a party to this thread" }, 403);
    return c.json({ thread, messages: alignmentThreads.messages(thread.id) });
  });

  app.post("/v1/alignment-threads/:id/messages", async (c) => {
    const identity = c.get("identity");
    const thread = alignmentThreads.get(c.req.param("id"));
    if (!thread) return c.json({ error: "no such thread" }, 404);
    if (!isThreadParty(identity, thread)) return c.json({ error: "not a party to this thread" }, 403);
    const body = await c.req.json<{ message?: string }>().catch(() => null);
    if (!body || !body.message) return c.json({ error: "expected { message }" }, 400);
    const message = alignmentThreads.postMessage(thread.id, identity.developerId, body.message);
    // Notify whichever party didn't just post -- rides the same
    // notice-polling delivery every other finding already uses.
    const otherParty = identity.developerId === thread.developerId ? thread.otherDeveloperId : thread.developerId;
    store.addNotice(otherParty, `twing align: ${identity.developerId} replied on an alignment thread: "${body.message}"`, Date.now(), thread.id);
    return c.json({ message });
  });

  app.patch("/v1/alignment-threads/:id/close", (c) => {
    const identity = c.get("identity");
    const thread = alignmentThreads.get(c.req.param("id"));
    if (!thread) return c.json({ error: "no such thread" }, 404);
    if (!isThreadParty(identity, thread)) return c.json({ error: "not a party to this thread" }, 403);
    const closed = alignmentThreads.close(thread.id, identity.developerId);
    return c.json({ status: closed?.status });
  });

  // §17.2: the one call twing-hook makes. Accepts either rawPlanText
  // (extraction runs here) or pre-structured fields (agent-supplied via
  // `twing design register`, extraction skipped). Registers the design and
  // returns the verdict in one round trip.
  app.post("/v1/designs/check", async (c) => {
    const identity = c.get("identity");
    const body = await c.req.json<DesignCheckRequestBody>().catch(() => null);
    if (!body || typeof body.projectId !== "string" || typeof body.sessionId !== "string") {
      return c.json({ error: "expected { projectId, sessionId, ... }" }, 400);
    }
    const authz = authorizeProject(identity, body.projectId);
    if (!authz.ok) return c.json({ error: authz.error }, authz.status);

    const hasStructured = Array.isArray(body.creates) || Array.isArray(body.touches) || Array.isArray(body.dependsOn) || typeof body.summary === "string";
    if (!body.rawPlanText && !hasStructured) {
      return c.json({ error: "expected rawPlanText, or structured creates/touches/dependsOn/summary" }, 400);
    }

    let creates = body.creates ?? [];
    let touches = body.touches ?? [];
    let dependsOn = body.dependsOn ?? [];
    let summary = body.summary ?? "";

    if (body.rawPlanText && !hasStructured) {
      const extracted = await extractDesign(body.rawPlanText, { model: extractModel, provider: extractProvider, apiKey: openRouterApiKey });
      creates = extracted.creates;
      touches = extracted.touches;
      dependsOn = extracted.dependsOn;
      summary = extracted.summary;
    }

    const design = designs.register({
      projectId: body.projectId,
      developerId: identity.developerId,
      sessionId: body.sessionId,
      agentLabel: body.agentLabel,
      summary,
      creates,
      touches,
      dependsOn,
      rawPlanExcerpt: body.rawPlanText?.slice(0, RAW_PLAN_EXCERPT_CHARS),
      ttlMs: body.ttlMs,
    });

    const open = designs.openDesigns(body.projectId, Date.now(), design.id);
    const constraints = constraintStore.forProject(body.projectId);
    const outcome = runDesignChecks(design, open, constraints);

    console.log(
      `twing serve: design ${design.id.slice(0, 8)} project ${body.projectId.slice(0, 12)} -> ${outcome.verdict}` +
        (outcome.conflicts.length > 0 ? ` (${outcome.conflicts.length} conflict(s))` : ""),
    );
    activityLog.append({
      projectId: body.projectId,
      developerId: identity.developerId,
      sessionId: body.sessionId,
      kind: "design_checked",
      relatedId: design.id,
      ts: Date.now(),
      payload: { verdict: outcome.verdict, conflictCount: outcome.conflicts.length },
    });

    // §17 scope enforcement (2026-08): a non-clean verdict demotes the
    // design out of "open" immediately -- before this response is ever
    // sent -- so it stops counting as a usable open design for the
    // Edit/Write gate's own-session check (`/v1/designs/scope-match`
    // below), rather than staying "open" until someone resolves it.
    if (outcome.verdict !== "clean") {
      designs.flag(design.id, outcome.verdict);
    }

    // §17 design lifecycle (2026-08): registering a new design is a much
    // faster, more precise signal of context-switch than any inactivity
    // window -- if this session already has other open/flagged designs
    // that this one genuinely doesn't overlap (not already caught by
    // outcome.conflicts above), nudge about it. Advisory only: nothing
    // about the sibling's status/lastActivityAt changes here -- dormancy
    // stays driven by inactivity alone, this is purely informational.
    const conflictingIds = new Set(outcome.conflicts.map((c) => c.conflictingDesignId));
    const staleSiblings = open.filter((d) => d.sessionId === body.sessionId && !conflictingIds.has(d.id));
    for (const sibling of staleSiblings) {
      const message =
        `twing design coordinator: you also have design ${sibling.id} [${sibling.status}] open ` +
        `("${sibling.summary || "no summary"}") that this new design doesn't touch. If that work is done, ` +
        `close it: twing design close --id ${sibling.id}`;
      activityLog.append({
        projectId: body.projectId,
        developerId: identity.developerId,
        sessionId: body.sessionId,
        kind: "design_stale_sibling_suggested",
        relatedId: sibling.id,
        ts: Date.now(),
        payload: { newDesignId: design.id, staleDesignId: sibling.id },
      });
      store.addNotice(identity.developerId, message, Date.now());
    }

    runSemanticComparatorPass(design.id, open);

    if (outcome.verdict === "clean") {
      return c.json({ verdict: "clean", designId: design.id });
    }
    if (outcome.verdict === "constraint_flag") {
      return c.json({ verdict: "constraint_flag", designId: design.id, constraint: outcome.constraint });
    }
    return c.json({ verdict: "overlap", designId: design.id, conflicts: outcome.conflicts });
  });

  // §17.5: adopt the conflicting design (superseded), or justify diverging
  // (queues to /v1/reviews -- does not unblock by itself).
  app.post("/v1/designs/:id/resolve", async (c) => {
    const identity = c.get("identity");
    const id = c.req.param("id");
    const design = designs.get(id);
    if (!design) return c.json({ error: "no such design" }, 404);
    if (!identity.projects.some((p) => p.projectId === design.projectId)) {
      return c.json({ error: "not a member of this project" }, 403);
    }

    const body = await c.req.json<ResolveRequestBody>().catch(() => null);
    if (!body || (body.resolution !== "adopted" && body.resolution !== "justified_divergence")) {
      return c.json({ error: "expected resolution: adopted | justified_divergence" }, 400);
    }

    if (body.resolution === "adopted") {
      designs.supersede(id);
      return c.json({ status: "superseded", adoptedDesignId: body.adoptedDesignId });
    }

    if (!body.justification) {
      return c.json({ error: "justified_divergence requires a justification" }, 400);
    }
    // §17 review-flow fix (2026-08): if this design is currently flagged for
    // a specific constraint, attribute the review to that constraint id --
    // re-running the check against the design's own unchanged scope (no
    // delta) is the cheapest way to discover it without persisting anything
    // new on the design row just for this. Undefined for an overlap-type
    // divergence, or a design that isn't currently constraint-flagged at
    // all -- addReview treats that the same as before this fix.
    const { outcome: currentOutcome } = checkAmendedScope(design, { touches: [], creates: [], dependsOn: [] });
    const constraintId = currentOutcome.verdict === "constraint_flag" ? currentOutcome.constraint?.id : undefined;
    const review = designs.addReview(id, design.projectId, body.justification, constraintId);
    console.log(`twing serve: design ${id.slice(0, 8)} justified divergence -> pending review ${review.id.slice(0, 8)}`);
    return c.json({ status: "pending_review", reviewId: review.id });
  });

  // §17.6: explicit close (also called by the SessionEnd hook path, per
  // design, per session -- not exposed as a separate bulk endpoint since the
  // hook already knows which session it is).
  app.patch("/v1/designs/:id/close", (c) => {
    const identity = c.get("identity");
    const id = c.req.param("id");
    const design = designs.get(id);
    if (!design) return c.json({ error: "no such design" }, 404);
    if (!identity.projects.some((p) => p.projectId === design.projectId)) {
      return c.json({ error: "not a member of this project" }, 403);
    }
    const closed = designs.close(id);
    return c.json({ status: closed?.status });
  });

  // §17 scope enforcement (2026-08): expand an *open* design's declared
  // creates/touches/dependsOn -- the escape hatch for legitimately touching
  // a file that wasn't declared at registration time. Re-runs the full
  // syntactic check (design-checks.ts tiers 1-3) against the *merged*
  // candidate before persisting anything, exactly like initial registration
  // does -- an amendment can't be used to silently launder a scope
  // expansion past overlap/constraint detection. On a non-clean verdict,
  // the amendment is rejected and the design's *existing* scope is left
  // untouched (still open) -- only the proposed addition is refused, same
  // adopt-or-justify path as initial registration, scoped to this same
  // design id. On success, kicks off a fresh full semantic-comparator pass
  // (runSemanticComparatorPass, above) that supersedes any still-running
  // pass from the prior registration/amendment.
  app.post("/v1/designs/:id/amend", async (c) => {
    const identity = c.get("identity");
    const id = c.req.param("id");
    const design = designs.get(id);
    if (!design) return c.json({ error: "no such design" }, 404);
    if (!identity.projects.some((p) => p.projectId === design.projectId)) {
      return c.json({ error: "not a member of this project" }, 403);
    }
    if (design.status !== "open") {
      return c.json({ error: `design is ${design.status}, not open -- can't amend` }, 409);
    }

    const body = await c.req.json<AmendRequestBody>().catch(() => null);
    const delta = { touches: body?.addTouches ?? [], creates: body?.addCreates ?? [], dependsOn: body?.addDependsOn ?? [] };
    if (delta.touches.length === 0 && delta.creates.length === 0 && delta.dependsOn.length === 0) {
      return c.json({ error: "expected at least one of addTouches/addCreates/addDependsOn" }, 400);
    }

    const { outcome, open } = checkAmendedScope(design, delta);

    // §17 review-flow fix (2026-08): a non-clean amend used to return the
    // verdict without persisting anything at all -- unlike a fresh
    // /v1/designs/check registration, which always persists its proposed
    // scope and only *then* flags on non-clean (see that route above). That
    // asymmetry meant `resolve --justify` + an admin's approval had nothing
    // to apply: `decideReview`'s approve path only reopens a design's
    // *existing* row as-is, it was never built to replay a delta that was
    // never written anywhere. Found live: an approved review didn't unblock
    // a rejected amend at all. Fix: persist the merged scope unconditionally
    // (via the same `designs.amend` used for the clean path), then flag on
    // non-clean -- exactly mirroring registration's pattern, so a later
    // approval correctly reopens the design with the scope that was
    // actually reviewed and signed off on.
    const amended = designs.amend(id, delta);
    if (!amended) return c.json({ error: `design is ${design.status}, not open -- can't amend` }, 409);

    if (outcome.verdict !== "clean") {
      console.log(`twing serve: design ${id.slice(0, 8)} amend rejected -> ${outcome.verdict}`);
      designs.flag(id, outcome.verdict);
      runSemanticComparatorPass(id, open);
      return c.json({ verdict: outcome.verdict, designId: id, conflicts: outcome.conflicts, constraint: outcome.constraint });
    }

    console.log(`twing serve: design ${id.slice(0, 8)} amended -> scopeVersion ${amended.scopeVersion}`);
    runSemanticComparatorPass(amended.id, open);
    return c.json({ verdict: "clean", designId: amended.id });
  });

  // §17 design lifecycle (2026-08): reactivate a *dormant* design -- always
  // an explicit, deliberate call, never triggered automatically by a file
  // matching its declared scope (see /v1/designs/scope-match's "dormant"
  // state, which denies and points here rather than silently waking it). A
  // file match isn't proof of intent to resume: a single long-lived session
  // can register design A, abandon it, and later touch a file A happens to
  // cover for entirely unrelated reasons. Cross-developer by design, same
  // as resolve/close -- any project member can pick up a design someone
  // else parked, not just the original session/developer; resume
  // reassigns both to whoever's calling this. Re-runs the full conflict
  // check against whatever's currently open before persisting anything,
  // exactly like amend -- on a non-clean verdict the design stays exactly
  // "dormant", nothing persists.
  app.post("/v1/designs/:id/resume", async (c) => {
    const identity = c.get("identity");
    const id = c.req.param("id");
    const design = designs.get(id);
    if (!design) return c.json({ error: "no such design" }, 404);
    if (!identity.projects.some((p) => p.projectId === design.projectId)) {
      return c.json({ error: "not a member of this project" }, 403);
    }
    if (design.status !== "dormant") {
      return c.json({ error: `design is ${design.status}, not dormant -- can't resume` }, 409);
    }

    const body = await c.req.json<ResumeRequestBody>().catch(() => null);
    if (!body || typeof body.sessionId !== "string") {
      return c.json({ error: "expected { sessionId, addTouches?, addCreates?, addDependsOn? }" }, 400);
    }
    const delta = { touches: body.addTouches ?? [], creates: body.addCreates ?? [], dependsOn: body.addDependsOn ?? [] };

    const { outcome, open } = checkAmendedScope(design, delta);

    // §17 review-flow fix (2026-08): same gap as /v1/designs/:id/amend
    // above -- a non-clean resume persisted nothing, leaving an approved
    // review with nothing to reopen. Fix: persist via `designs.resume`
    // unconditionally (dormant -> open, scope + identity reassigned), then
    // `flag` demotes it to "flagged" on non-clean -- composing the two
    // existing store methods rather than adding a third path, and leaving
    // the design addressable (not stuck "dormant") for the same
    // resolve/review flow every other non-clean verdict already uses.
    const resumed = designs.resume(id, { sessionId: body.sessionId, developerId: identity.developerId, delta });
    if (!resumed) return c.json({ error: `design is ${design.status}, not dormant -- can't resume` }, 409);

    if (outcome.verdict !== "clean") {
      console.log(`twing serve: design ${id.slice(0, 8)} resume rejected -> ${outcome.verdict}`);
      designs.flag(id, outcome.verdict);
      runSemanticComparatorPass(id, open);
      return c.json({ verdict: outcome.verdict, designId: id, conflicts: outcome.conflicts, constraint: outcome.constraint });
    }

    console.log(`twing serve: design ${id.slice(0, 8)} resumed by ${identity.developerId.slice(0, 12)}/${body.sessionId.slice(0, 12)}`);
    runSemanticComparatorPass(resumed.id, open);
    return c.json({ verdict: "clean", designId: resumed.id });
  });

  // Visibility/debugging (§17.2). Was also what the hook's Edit|Write gate
  // used to check "is there an open design for my session" -- superseded by
  // /v1/designs/scope-match below (§17 scope enforcement, 2026-08), which
  // additionally checks the specific file against that design's own scope.
  app.get("/v1/designs", (c) => {
    const identity = c.get("identity");
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "expected ?projectId=" }, 400);
    if (!identity.projects.some((p) => p.projectId === projectId)) {
      return c.json({ error: "not a member of this project" }, 403);
    }
    const status = c.req.query("status") as DesignStatement["status"] | undefined;
    const sessionId = c.req.query("sessionId");
    let items = designs.listByProject(projectId, status);
    if (sessionId) items = items.filter((d) => d.sessionId === sessionId);
    return c.json({ items });
  });

  // §17 scope enforcement (2026-08): the design equivalent of
  // /v1/constraints/match's ground-truth backstop below -- checks the
  // literal file being edited against the session's own *open* design(s)
  // directly, instead of trusting "the session has *a* design registered"
  // as proof enough. Five states, most-actionable-first:
  //  - "in_scope": an open design covers `path` (or none given -- can't
  //    verify, same permissiveness as the old plain "has an open design"
  //    check) -- also refreshes that design's `lastActivityAt` (§17 design
  //    lifecycle, 2026-08: this is the one place real per-design activity
  //    gets recorded, since this call already round-trips synchronously on
  //    every real Edit/Write).
  //  - "out_of_scope": an open design exists but none cover `path`.
  //  - "dormant" (§17 design lifecycle, 2026-08): no open design (matching
  //    or not), but a dormant one exists -- never silently allowed or
  //    woken; points at `twing design resume`, which re-checks against
  //    whatever's live before reactivating anything.
  //  - "flagged": something's registered, but its own verdict wasn't clean
  //    (DesignRegistry.flag) -- resolve it before it counts as usable.
  //  - "no_design": nothing registered for this session at all (or
  //    everything's closed/superseded/expired).
  app.get("/v1/designs/scope-match", (c) => {
    const identity = c.get("identity");
    const projectId = c.req.query("projectId");
    const sessionId = c.req.query("sessionId");
    if (!projectId || !sessionId) {
      return c.json({ error: "expected ?projectId=&sessionId=" }, 400);
    }
    const authz = authorizeProject(identity, projectId);
    if (!authz.ok) return c.json({ error: authz.error }, authz.status);
    const path = c.req.query("path");

    const sessionDesigns = designs
      .listByProject(projectId)
      .filter((d) => d.sessionId === sessionId && (d.status === "open" || d.status === "flagged" || d.status === "dormant"));
    if (sessionDesigns.length === 0) return c.json({ state: "no_design" });

    const openOnes = sessionDesigns.filter((d) => d.status === "open");
    if (openOnes.length > 0) {
      if (!path) return c.json({ state: "in_scope" });
      const hit = openOnes.find((d) => pathInDesignScope(path, d));
      if (hit) {
        designs.touch(hit.id);
        return c.json({ state: "in_scope", designId: hit.id });
      }
      return c.json({ state: "out_of_scope", designId: openOnes[openOnes.length - 1].id });
    }

    const dormantOnes = sessionDesigns.filter((d) => d.status === "dormant");
    if (dormantOnes.length > 0) {
      const now = Date.now();
      const named = (path && dormantOnes.find((d) => pathInDesignScope(path, d))) || dormantOnes[dormantOnes.length - 1];
      return c.json({ state: "dormant", designId: named.id, summary: named.summary, dormantSinceMs: now - named.lastActivityAt });
    }

    // Only flagged designs remain, since sessionDesigns was non-empty and
    // openOnes/dormantOnes were both empty. pendingReview distinguishes
    // "never resolved" from "resolved, an admin just hasn't decided yet"
    // (found live, 2026-08-16) -- both used to render as the identical
    // deny telling you to run `twing design resolve`, even right after
    // you'd already done so.
    const flaggedDesign = sessionDesigns[sessionDesigns.length - 1];
    return c.json({ state: "flagged", designId: flaggedDesign.id, pendingReview: designs.hasPendingReview(flaggedDesign.id) });
  });

  // §17.5: the human-facing queue -- justified divergences pending sign-off.
  app.get("/v1/reviews", (c) => {
    const identity = c.get("identity");
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "expected ?projectId=" }, 400);
    if (!identity.projects.some((p) => p.projectId === projectId)) {
      return c.json({ error: "not a member of this project" }, 403);
    }
    return c.json({ items: designs.listReviews(projectId) });
  });

  // §17.10 hardening: deciding a review requires being that project's
  // admin, not mere token possession -- closes the gap flagged against the
  // old shared-token model.
  app.post("/v1/reviews/:id/decide", async (c) => {
    const identity = c.get("identity");
    const id = c.req.param("id");
    const review = designs.getReview(id);
    if (!review) return c.json({ error: "no such review" }, 404);
    if (!canManageProject(identity, review.projectId)) {
      return c.json({ error: "not an admin of this project" }, 403);
    }
    const body = await c.req.json<{ decision?: "approve" | "reject" }>().catch(() => null);
    if (!body || (body.decision !== "approve" && body.decision !== "reject")) {
      return c.json({ error: "expected decision: approve | reject" }, 400);
    }
    const decided = designs.decideReview(id, body.decision);
    console.log(`twing serve: review ${id.slice(0, 8)} decided -> ${body.decision}`);
    return c.json({ review: decided });
  });

  // §17.2/§17.6's cold-start seed: `twing init` forwards this repo's local
  // .twing/twing.yml constraints so the Constraint Store starts non-empty
  // without the server needing filesystem access to anyone's checkout.
  //
  // Admin-gated past the initial founding (2026-08-16, found live): before
  // this, `authorizeProject` alone let *any* project member re-seed --
  // meaning anyone gated by a review_required rule could unilaterally
  // narrow/widen/delete it themselves via a local .twing/twing.yml edit +
  // `twing init`, no different in effect from the rule not existing. The
  // one exception is founding a brand-new project, which is what
  // `authorizeProject`'s own auto-admit path is for -- seeding is the
  // first project-scoped call `twing init` makes, so it doubles as the
  // founding trigger and must stay open to non-admins for that one case.
  app.post("/v1/constraints/seed", async (c) => {
    const identity = c.get("identity");
    const body = await c.req.json<SeedRequestBody>().catch(() => null);
    if (!body || typeof body.projectId !== "string" || !Array.isArray(body.constraints)) {
      return c.json({ error: "expected { projectId, constraints: [{statement, scope, type?}] }" }, 400);
    }
    const projectId = body.projectId;
    const alreadyFounded = identities.isProjectFounded(projectId);
    const authz = authorizeProject(identity, projectId);
    if (!authz.ok) return c.json({ error: authz.error }, authz.status);
    if (alreadyFounded && !canManageProject(identity, projectId)) {
      return c.json({ error: "not an admin of this project -- constraint changes to an existing project require admin role" }, 403);
    }

    const added = body.constraints.map((entry) =>
      constraintStore.add(projectId, entry.statement, entry.scope, entry.type ?? "canonical_abstraction", "seeded"),
    );
    return c.json({ seeded: added.length });
  });

  // §17.9: the ground-truth backstop. Checks one literal path against the
  // Constraint Store directly -- no design registration involved, so it
  // can't be sidestepped by a session whose registered design just never
  // happens to mention the path it's about to edit. Called by the
  // Edit|Write gate on every tool call, ahead of (and independent of) the
  // "does this session have an open design at all" check.
  app.get("/v1/constraints/match", (c) => {
    const identity = c.get("identity");
    const projectId = c.req.query("projectId");
    const path = c.req.query("path");
    if (!projectId || !path) {
      return c.json({ error: "expected ?projectId=&path=" }, 400);
    }
    const authz = authorizeProject(identity, projectId);
    if (!authz.ok) return c.json({ error: authz.error }, authz.status);
    const hit = matchConstraintsForPaths([path], constraintStore.forProject(projectId));
    if (hit) {
      console.log(`twing serve: constraint match on ${path} (project ${projectId.slice(0, 12)}) -- ${hit.type}: ${hit.statement}`);
    }
    return c.json({ matched: hit !== undefined, constraint: hit });
  });

  return app;
}
