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
import { cors } from "hono/cors";
import type { Claim, CallEdge, DesignStatement, DesignConstraintType, Finding, PendingReview } from "@twing/core";
import { type Db, createDb } from "./db/client.js";
import { Store } from "./store.js";
import { findClaimConflicts, type ClaimFindingMatch } from "./checks.js";
import { DesignRegistry, ConstraintStore } from "./design-store.js";
import {
  runDesignChecks,
  matchConstraintsForPaths,
  pathInDesignScope,
  mergeDesignScope,
  appendSummaryUpdate,
  jaccard,
  PLAN_RETRY_SIMILARITY_THRESHOLD,
  structuralOverlaps,
  pathsOverlap,
  shouldFlagOtherSide,
  isDesignSideSettled,
  isDesignSideDormantOrSettled,
  isDesignLive,
} from "./design-checks.js";
import { extractDesign } from "./design-extract.js";
import { getServerVersion } from "./version.js";
import { checkSemanticConflict } from "./design-semantic-check.js";
import { findDesignDivergences } from "./design-divergence.js";
import { enrichReviews } from "./review-enrich.js";
import { AlignmentThreadStore, buildAlignmentSummary, type AlignmentSubKind, type AlignmentThread } from "./alignment-store.js";
import { DrizzleActivityLog, type ActivityEventKind } from "./activity-log.js";
import { IdentityStore, type ResolvedIdentity, type InviteScope, type Role } from "./identity-store.js";
import { fetchRepoPermissions } from "./github-client.js";

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
  // §17 design linking (2026-08): unlike developerId (resolved from the
  // authenticated identity, never client-supplied), groupId IS
  // client-suppliable -- it's not identity-bearing, just a caller-chosen
  // link label. Optional: self-assigned server-side to this design's own
  // id when omitted. See DesignStatement.groupId (@twing/core).
  groupId?: string;
}

interface ResolveRequestBody {
  resolution?: "adopted" | "justified_divergence";
  adoptedDesignId?: string;
  justification?: string;
}

// §17 scope enforcement (2026-08): "add" fields only -- amend expands an
// open design's declared scope, it never removes from it. `summary`
// (2026-08-17) is no exception to that anymore either: a provided summary
// is appended as a dated `Update:` entry (design-checks.ts's
// `appendSummaryUpdate`, reversed from the original replace-outright design
// 2026-08-18 -- a scope-only amend that just wanted to explain *why* was
// silently destroying the design's entire original context).
interface AmendRequestBody {
  addTouches?: string[];
  addCreates?: string[];
  addDependsOn?: string[];
  summary?: string;
  /** §17 design linking (2026-08): join (or move to) a different group
   * after registration -- see DesignRegistry.amend's `groupId` param doc
   * comment for the full reasoning. */
  groupId?: string;
  /** Change D (2026-08-31, design-gate registration-flow fixes): move an
   * open, never-linked, nothing-built-on-it-yet design into a different
   * project -- fixes a wrong-project registration in place instead of the
   * only prior options (close-and-reregister, or force-a-duplicate-and-
   * link). Mutually exclusive with every other field on this body -- see
   * the route's own handling for why it's checked before the general
   * scope-amend path, not folded into it. */
  reassignProjectId?: string;
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
  /** §17 Phase 3: best-effort, computed client-side by `init.ts` from the
   * repo's own `origin` remote -- absent for a non-GitHub-hosted repo.
   * Only ever consulted on first founding (see authorizeProject below);
   * never updated on a re-seed of an already-founded project. */
  githubOwner?: string;
  githubRepo?: string;
}

interface JoinViaGithubRequestBody {
  githubToken?: string;
  /** Self-attested, only consulted when the project isn't founded yet (same
   * trust level `SeedRequestBody`'s founding path already uses) -- for an
   * already-founded project the stored `ProjectRecord.githubOwner`/
   * `githubRepo` is the ground truth and this is ignored, never trusted for
   * the permission check itself. */
  githubOwner?: string;
  githubRepo?: string;
  tokenHash?: string;
  label?: string;
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
  /** Bedrock model id for design-extract.ts's plan->fields extraction (see
   * llm-client.ts's header comment) -- defaults to the same model
   * semanticCheckModel does below, the one this repo's own eval validated
   * against a Bedrock account with credits. */
  extractModel?: string;
  /** design-semantic-check.ts's model -- defaults to the model this repo's
   * own eval settled on. */
  semanticCheckModel?: string;
  /** §17 Phase 4: no identity verification at all -- every /v1/* request
   * must carry a self-declared X-Twing-Developer-Id header (attribution
   * only, never access control) instead of a bearer PAT, and every
   * admin/membership check below no-ops. For a single developer's local
   * agents or a small trusted team on a private network, not a public
   * deployment. Defaults to false (full auth, unchanged). */
  noAuth?: boolean;
  /** twing-monitor v1: explicit browser-origin allowlist for the `/v1/*`
   * API (`TWING_SERVE_CORS_ORIGINS`, comma-separated, wired in main.ts).
   * Undefined/empty mounts no CORS middleware at all -- zero behavior
   * change for existing self-hosted deployments that only ever talk to
   * this server from the CLI/hook (neither is a browser, neither needs
   * CORS headers). Never `*` -- a PAT rides as a real bearer credential
   * on these routes, not public data, so the allowlist has to be explicit
   * origins a self-hosted operator opts in by name. */
  corsOrigins?: string[];
  /** What `/v1/version` reports, and what the version-mismatch middleware
   * below compares an incoming `x-twing-hook-version` header against.
   * Defaults to this package's own `package.json` version -- injectable
   * for tests that need a deliberately different value. */
  version?: string;
  /** Public "observe twing getting built" demo (2026-08-28, generalized
   * from a single id to a list the same day, `TWING_PUBLIC_PROJECT_IDS` in
   * main.ts): the project ids an unauthenticated GET request is allowed to
   * read, or undefined/empty (the default) for zero behavior change from
   * today -- this repo doesn't expect any deployment but this one to ever
   * set it. See the auth middleware below for the actual mechanism. */
  publicProjectIds?: string[];
}

type Variables = { identity: ResolvedIdentity };

export function createApp(options: CreateAppOptions = {}) {
  const db = options.db ?? createDb({ dataDir: options.dataDir });
  const store = options.store ?? new Store(db);
  const designs = options.designs ?? new DesignRegistry(db);
  const constraintStore = options.constraints ?? new ConstraintStore(db);
  const identities = options.identities ?? new IdentityStore(db, { dataDir: options.dataDir });
  const alignmentThreads = options.alignmentThreads ?? new AlignmentThreadStore(db);
  const activityLog = new DrizzleActivityLog(db);
  // Tightening alignment threads item 4 (2026-08-27): wired here, after
  // both `designs` and `alignmentThreads` locals exist, rather than only
  // via `DesignRegistryOptions`'s constructor option -- `designs` may
  // already be a caller-supplied, pre-constructed `DesignRegistry` (every
  // test's `freshApp()` does this), so this is the one place that reaches
  // both the self-constructed and injected cases alike. `maybeDormThread`
  // is defined further down as a function declaration (hoisted), so it's
  // already callable here despite the later textual position.
  designs.setOnDesignsWentDormant((designIds) => {
    for (const id of designIds) {
      const design = designs.get(id); // still exists, now with status "dormant" -- just for its projectId
      if (!design) continue;
      for (const t of alignmentThreads.listByProject(design.projectId, "open")) {
        if (t.initiatingDesignId === id || t.designId === id) maybeDormThread(t.id);
      }
    }
  });
  const extractModel = options.extractModel ?? "google.gemma-4-31b";
  const semanticCheckModel = options.semanticCheckModel ?? "google.gemma-4-31b";
  const noAuth = options.noAuth ?? false;
  const publicProjectIds = options.publicProjectIds;
  const version = options.version ?? getServerVersion();

  const app = new Hono<{ Variables: Variables }>();

  // twing-monitor v1: mounted before the auth middleware below (source
  // order matters in Hono) so a browser's `OPTIONS` preflight -- which
  // never carries an `Authorization` header -- gets its CORS headers
  // without first hitting the 401 path. Only controls whether a browser
  // may attach the header cross-origin; the auth mechanism itself is
  // unchanged, an actual request still needs a real bearer token.
  if (options.corsOrigins && options.corsOrigins.length > 0) {
    app.use("/v1/*", cors({ origin: options.corsOrigins, allowHeaders: ["Content-Type", "Authorization", "X-Twing-Developer-Id"] }));
  }

  // Version-compatibility enforcement: mounted before the auth middleware
  // below (source order matters in Hono) so a stale twing-hook binary gets
  // this specific, actionable 426 even when its cached token would *also*
  // be rejected -- "you're out of date" is more useful than "unauthorized"
  // when both are true. Scoped precisely to requests that set this header;
  // no other caller (align/design/admin/project commands, the daemon's sync
  // loop, twing-monitor's browser calls) ever does, so this is a zero-risk
  // addition to every other /v1/* code path.
  //
  // Deliberately does NOT try to treat a *missing* header as "must be an
  // old hook binary, deny it" (attempted and reverted, 2026-08-27, found
  // live via a real test failure): /v1/designs/check, /v1/designs/extract,
  // and /v1/constraints/match aren't hook-exclusive -- the TS CLI's own
  // design.ts/constraints.ts commands (twing design register/resolve/
  // resume, etc.) call these same routes directly and never send this
  // header either, since only the Go hook does. Route-scoping "missing =
  // deny" to them 426'd real, legitimate CLI traffic. The bootstrap gap
  // this would have closed (a pre-0.2.6 hook binary, with no code to send
  // this header at all, is invisible to this check) is a one-time,
  // first-release-only limitation, not an ongoing one -- every 0.2.6+
  // hook binary always sends a header, so there is nothing left to
  // retroactively detect once real installs move past this release.
  app.use("/v1/*", async (c, next) => {
    const hookVersion = c.req.header("x-twing-hook-version");
    if (hookVersion && hookVersion !== version) {
      return c.json({ error: "hook_version_mismatch", hookVersion, serverVersion: version }, 426);
    }
    return next();
  });

  // §17.10: every /v1/* route requires a valid bearer PAT, except the two
  // that can't assume one exists yet -- bootstrap (nobody has a PAT before
  // their first one) and invite redemption (works both authenticated, for
  // an existing developer joining a second org/project, and unauthenticated,
  // for a brand-new developer redeeming with a freshly-generated token).
  app.use("/v1/*", async (c, next) => {
    if (c.req.path === "/v1/admin/bootstrap") return next();
    if (/^\/v1\/invites\/[^/]+\/redeem$/.test(c.req.path)) return next();
    if (/^\/v1\/projects\/[^/]+\/join-via-github$/.test(c.req.path)) return next();
    if (c.req.path === "/v1/version") return next();
    if (noAuth) {
      // §17 Phase 4: no bearer token at all -- a self-declared developerId
      // is still required on every request (attribution for align/§17's
      // notices and activity log, never access control), so a missing
      // header is a hard 400, never a silent "anonymous" default.
      const developerId = c.req.header("x-twing-developer-id");
      if (!developerId) {
        return c.json({ error: "no_auth mode: missing X-Twing-Developer-Id header -- pass a self-declared developer id on every request" }, 400);
      }
      c.set("identity", { developerId, orgs: [], projects: [] });
      return next();
    }
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    // Public "observe twing getting built" demo (2026-08-28, generalized
    // from a single project to a list the same day): an unauthenticated
    // GET (no bearer token at all -- an empty one after stripping "Bearer "
    // counts the same as a missing header, so twing-monitor's own
    // apiFetch, which always sends *an* Authorization header, works
    // unchanged with authToken: "") is met with a synthetic identity that's
    // a member of every project in publicProjectIds, undefined/empty
    // unless TWING_PUBLIC_PROJECT_IDS is set (main.ts). This adds no new
    // authorization logic: every route below still goes through
    // isProjectMember/canManageProject exactly as it always has, and this
    // identity is only ever a member of the allowlisted projects, so those
    // checks already refuse anything else. GET-only by construction --
    // this branch is never reached for a mutating method, which falls
    // through to the unchanged 401 below exactly as it would for any other
    // missing/invalid credential.
    if (!token && c.req.method === "GET" && publicProjectIds && publicProjectIds.length > 0) {
      c.set("identity", {
        developerId: "public-viewer",
        orgs: [],
        projects: publicProjectIds.map((projectId) => ({ projectId, orgId: "", role: "member" as const })),
        isPublicViewer: true,
      });
      return next();
    }
    const identity = token ? identities.resolveToken(token) : undefined;
    if (!identity) {
      return c.json({ error: "unauthorized -- run `twing login --token <pat>` (or `twing keygen --invite <code>` if you don't have one yet)" }, 401);
    }
    c.set("identity", identity);
    return next();
  });

  app.get("/", (c) => c.text("twing serve"));

  // Unauthenticated on purpose: a fresh install with no cached token yet
  // still needs to learn it's out of date, not hit a 401 first.
  app.get("/v1/version", (c) => c.json({ version }));

  // §17.10: who am I, and what am I a member of -- what `twing whoami` and
  // `twing login`'s validation step both call.
  app.get("/v1/auth/whoami", (c) => c.json(c.get("identity")));

  // twing-monitor v1: "list my repos" for the dashboard's landing view. A
  // dedicated route rather than folding this into whoami's response --
  // whoami is a CLI/hook-consumed identity primitive (small, stable
  // shape), not a UI listing endpoint. Merges each of the caller's
  // memberships (already resolved on the identity, §17.10) with that
  // project's own record for the fields a dashboard actually wants
  // (githubOwner/githubRepo/foundedBy/foundedAt) -- no new IdentityStore
  // method needed, getProjectRecord already exists.
  app.get("/v1/projects", (c) => {
    const identity = c.get("identity");
    // §17 Phase 4: a no_auth identity has no per-caller memberships
    // (identity.projects is always []), so list every founded project
    // instead -- there's no cross-org isolation to preserve on a no_auth
    // coordinator. role is reported "admin" to match no_auth's flat
    // capability model (canManageProject returns true for everyone here).
    if (noAuth) {
      const items = identities.listAllProjectRecords().map((record) => ({
        projectId: record.projectId,
        orgId: record.orgId,
        role: "admin" as const,
        foundedBy: record.foundedBy,
        foundedAt: record.foundedAt,
        githubOwner: record.githubOwner,
        githubRepo: record.githubRepo,
      }));
      return c.json({ items });
    }
    const items = identity.projects.map((membership) => {
      const record = identities.getProjectRecord(membership.projectId);
      return {
        projectId: membership.projectId,
        orgId: membership.orgId,
        role: membership.role,
        foundedBy: record?.foundedBy,
        foundedAt: record?.foundedAt,
        githubOwner: record?.githubOwner,
        githubRepo: record?.githubRepo,
      };
    });
    return c.json({ items });
  });

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

  /** §17 Phase 4 no_auth carve-out, shared by every membership check below:
   * short-circuits to true rather than synthesizing a fake all-admin
   * identity object, so what "member"/"admin" mean elsewhere in this file
   * is untouched. */
  function isProjectMember(identity: ResolvedIdentity, projectId: string): boolean {
    return noAuth || identity.projects.some((p) => p.projectId === projectId);
  }

  function canManageProject(identity: ResolvedIdentity, projectId: string): boolean {
    if (noAuth) return true;
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
      scope.kind === "org" ? noAuth || identity.orgs.some((o) => o.orgId === scope.orgId && o.role === "admin") : canManageProject(identity, scope.projectId);
    if (!authorized) return c.json({ error: "not authorized to revoke this invite" }, 403);
    identities.revokeInvite(invite.code);
    return c.json({ status: "revoked" });
  });

  app.get("/v1/projects/:id/developers", (c) => {
    const identity = c.get("identity");
    const projectId = c.req.param("id");
    if (!isProjectMember(identity, projectId)) return c.json({ error: "not a member of this project" }, 403);
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
  function authorizeProject(
    identity: ResolvedIdentity,
    projectId: string,
    github?: { owner: string; repo: string },
  ): { ok: true } | { ok: false; status: 403; error: string } {
    if (noAuth) {
      // §17 Phase 4: no identity tables exist to found from the normal way
      // (foundProject needs an org row, foundProjectViaGithub needs a token
      // + GitHub check), but the project still has to get a record so it
      // shows up in GET /v1/projects and carries its GitHub binding. Every
      // project-scoped route reaches here, so this is the same lazy-founding
      // breadth the authed path gets below. Idempotent via isProjectFounded.
      if (!identities.isProjectFounded(projectId)) {
        identities.foundProjectNoAuth(projectId, identity.developerId, github);
      }
      return { ok: true };
    }
    if (identity.projects.some((p) => p.projectId === projectId)) return { ok: true };
    if (!identities.isProjectFounded(projectId)) {
      const founded = identities.foundProject(projectId, identity.developerId, github);
      if ("error" in founded) return { ok: false, status: 403, error: founded.error };
      // foundProject (the invite/admin-bootstrap founding path) always sets
      // a real orgId -- the ?? "" is only to satisfy ResolvedIdentity's
      // contract (same "" -for-none convention resolveToken already uses),
      // never actually hit here.
      identity.projects.push({ projectId, orgId: founded.orgId ?? "", role: "admin" });
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
   *
   * Skips same-developer pairs (2026-08-22) -- no LLM call, no alignment
   * thread, no notice. There's no second party to align with when both
   * designs are the same developer's own agents/sessions; a usability pass
   * on twing-monitor found this was the single noisiest source of feed
   * clutter (every one of this project's alignment threads was a self-pair,
   * and each self-pair also double-notified the same developerId below --
   * `addNotice(current.developerId, ...)` immediately followed by
   * `addNotice(other.developerId, ...)`, identical args when the two ids
   * match). See design-checks.ts's top-of-file comment for the full
   * writeup.
   *
   * **2026-08-22: blocking.** A hit now also flags the candidate
   * (`designs.flag(..., "llm_divergence", ...)`) alongside the existing
   * alignment-thread/notice/activity-log side effects -- see DesignVerdict's
   * doc comment (core/types.ts) for the full four-bucket model this belongs
   * to. Deliberately *not* synchronous: this still runs after the
   * triggering response was already sent, so it can't deny the registration
   * itself (and a few files may already have been edited by the time it
   * lands) -- it flips the design's `status` to `"flagged"` so the *next*
   * `Edit`/`Write` in that session is denied by the existing, unchanged
   * `/v1/designs/scope-match` check, same enforcement path `constraint_violation`
   * and `symbol_conflict` already use. Unlike those two, an `llm_divergence`
   * (and `symbol_conflict`) block is self-approvable -- see
   * `/v1/designs/:id/resolve`'s auto-decide branch below. Skips any
   * `other.id` already in `current.justifiedConflicts` before even calling
   * the LLM -- an approved justification must not just re-flag on the very
   * next pass (mirrors how `structuralOverlaps` skips already-waived
   * `justifiedOverlaps` paths).
   */
  function runSemanticComparatorPass(candidateId: string, others: DesignStatement[]): void {
    const started = designs.get(candidateId);
    if (!started) return;
    const startVersion = started.scopeVersion;
    const candidateDeveloperId = started.developerId;
    void (async () => {
      for (const other of others) {
        if (other.developerId === candidateDeveloperId) continue;
        const current = designs.get(candidateId);
        if (!current || current.scopeVersion !== startVersion) return; // superseded by a later amend -- stop
        if (current.justifiedConflicts.includes(other.id)) continue;
        const result = await checkSemanticConflict(current, other, { model: semanticCheckModel });
        if (!result.conflict) continue;
        // `isValidResult` (design-semantic-check.ts) doesn't runtime-enforce
        // that a non-null `kind` accompanies `conflict: true` -- fall back to
        // "tension" (the most generic sub-kind) rather than drop a genuine
        // conflict signal over a model-schema inconsistency. `kind` is the
        // detail label (`AlignmentSubKind`) under the `"llm_divergence"`
        // bucket, not the thread's top-level category (2026-08-26).
        const subKind = result.kind ?? "tension";
        // Re-fetch both sides live, right before acting on the result --
        // `current` (above) was fetched before the slow `checkSemanticConflict`
        // await, and `other` is still the `others` snapshot this whole async
        // pass started with; either may have closed/gone dormant/been
        // reflagged in the meantime. `designs.flag()` already re-checks
        // liveness itself (its own status guard, design-store.ts) so the
        // actual block/no-block outcome below was always race-safe -- this
        // is for `reopenEligible` (2026-08-28), which `alignment-store.ts`'s
        // `findOrCreate` has no way to compute on its own: a design that
        // closed mid-check must not silently reopen its own already-closed
        // thread, but a genuinely new finding still deserves to reopen one
        // if the *other* side is still live.
        const liveCurrent = designs.get(current.id);
        const liveOther = designs.get(other.id);
        const reopenEligible = isDesignLive(liveCurrent) || isDesignLive(liveOther);
        const thread = alignmentThreads.findOrCreate({
          projectId: current.projectId,
          symbolIds: [], // no real symbol for a design-vs-design finding
          developerId: current.developerId,
          otherDeveloperId: other.developerId,
          designId: other.id,
          systemDescription: result.reason,
          category: "llm_divergence",
          subKind,
          summary: buildAlignmentSummary(subKind, other.summary, 0),
          initiatingDesignId: current.id, // this path always has a real initiating design -- always resolvable
          ts: Date.now(),
          reopenEligible,
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
        designs.flag(current.id, "llm_divergence", {
          conflicts: [
            {
              conflictingDesignId: other.id,
              agentLabel: other.agentLabel,
              overlapKind: "touches",
              overlapDetail: result.reason,
              conflictingSummary: other.summary,
              overlapPaths: [],
            },
          ],
        });
        // Both-sides blocking (2026-08-27) -- see shouldFlagOtherSide's own
        // doc comment (design-checks.ts) for the full reasoning. Reuses the
        // `liveOther` fetched above rather than re-fetching a second time.
        if (shouldFlagOtherSide(liveOther, current.id)) {
          designs.flag(other.id, "llm_divergence", {
            conflicts: [
              {
                conflictingDesignId: current.id,
                agentLabel: current.agentLabel,
                overlapKind: "touches",
                overlapDetail: result.reason,
                conflictingSummary: current.summary,
                overlapPaths: [],
              },
            ],
          });
        }
        // Reopen-on-new-finding fix (2026-08-28): the thread may have just
        // been created/reopened above (nothing to settle) or may have been
        // an already-open one that this finding didn't actually change the
        // settledness of -- either way, harmless to check. Only matters
        // when `findOrCreate` matched an already-*open* thread whose both
        // sides had, in the meantime, actually settled (closed/justified) --
        // this is the other half of the 169d101e-class bug: posting a new
        // message never used to re-run the close check at all.
        maybeAutoCloseThread(thread.id);
      }
    })().catch((err) => console.error("twing serve: semantic conflict check failed", err));
  }

  /** Tightening alignment threads, item 3 (2026-08-27): a thread can now
   * auto-close once *both* parties have settled their own half of it --
   * see `isDesignSideSettled` (design-checks.ts) for exactly what "settled"
   * means per side (resolved via an approved justification, or simply
   * closed -- including the terminal side-effect of a *rejected* one).
   * Called after any event that could be the second side settling: a
   * decide (below) or an explicit design close (the close route). No-op if
   * the thread's already closed, not `symbol_conflict`/`llm_divergence`
   * (pre-2026-08-26 uncategorized rows, or a `file_overlap` -- which never
   * gets a thread at all, see alignment-store.ts's header comment), or
   * missing either design id (same legacy-row guard). Closes author-less
   * (`alignmentThreads.close(id)`, no `closedBy`) -- this is the
   * coordinator's own conclusion, not one party's unilateral action, so it
   * shouldn't read as either party having closed it themselves. */
  function maybeAutoCloseThread(threadId: string): void {
    const thread = alignmentThreads.get(threadId);
    if (!thread || thread.status !== "open") return;
    if (thread.category !== "llm_divergence" && thread.category !== "symbol_conflict") return;
    if (!thread.initiatingDesignId || !thread.designId) return;
    const initiatingSettled = isDesignSideSettled(designs.get(thread.initiatingDesignId), thread.designId, thread.category);
    const otherSettled = isDesignSideSettled(designs.get(thread.designId), thread.initiatingDesignId, thread.category);
    if (!initiatingSettled || !otherSettled) return;
    alignmentThreads.postSystemMessage(threadId, "Auto-closed: both sides have resolved or closed their design -- nothing more to track here.");
    alignmentThreads.close(threadId);
  }

  /** Tightening alignment threads, item 4 (2026-08-27): the dormancy
   * counterpart to `maybeAutoCloseThread` above -- called only from
   * `DesignRegistry`'s `onDesignsWentDormant` hook (wired near the top of
   * `createApp`), never from a decide/close route, since dormancy is
   * always an inactivity side-effect, never a deliberate action. Demotes
   * an *open* thread to `"dormant"` once *both* sides are at least
   * dormant-or-settled (`isDesignSideDormantOrSettled`, design-checks.ts --
   * the looser sibling of `isDesignSideSettled`: a side that's merely gone
   * idle counts here, unlike for closing). If both sides are actually
   * fully settled (closed/resolved, not just dormant),
   * `maybeAutoCloseThread` would already have closed this thread the
   * moment the second side settled -- so by the time this ever runs on an
   * `"open"` thread, at least one side going dormant is what's new. Same
   * guard rails as `maybeAutoCloseThread` otherwise (must be `"open"`,
   * must be a `symbol_conflict`/`llm_divergence` thread with both design
   * ids present). */
  function maybeDormThread(threadId: string): void {
    const thread = alignmentThreads.get(threadId);
    if (!thread || thread.status !== "open") return;
    if (thread.category !== "llm_divergence" && thread.category !== "symbol_conflict") return;
    if (!thread.initiatingDesignId || !thread.designId) return;
    const initiatingQuiet = isDesignSideDormantOrSettled(designs.get(thread.initiatingDesignId), thread.designId, thread.category);
    const otherQuiet = isDesignSideDormantOrSettled(designs.get(thread.designId), thread.initiatingDesignId, thread.category);
    if (!initiatingQuiet || !otherQuiet) return;
    alignmentThreads.postSystemMessage(threadId, "Dormant: both sides have gone quiet -- resolve, close, or resume a design to bring this back.");
    alignmentThreads.dormant(threadId);
  }

  /** (2026-08-26) Resolving a design's block -- self-approve or admin-decide,
   * both end in `designs.decideReview` -- never touched the paired
   * alignment thread at all: `findOrCreate`/`postMessage`/`close` are the
   * only writers, and neither decide path calls any of them. From the
   * thread's own point of view, a conflict that got justified and cleared
   * within a minute looked identical to one nobody ever came back to --
   * both just sat "open" forever with no trace of what happened, found
   * live investigating why real production threads looked unresolved.
   *
   * Posts one system note per thread this decision actually settles, read
   * back from the review's own already-computed `conflictWaivers`/
   * `symbolConflictWaivers` (not re-derived -- those were fixed at
   * justify-time). Both waiver kinds are symmetric now (2026-08-26,
   * alignment-store.ts's `findOrCreate` reverse-direction fix): either
   * waiver list can point at a thread where this design is the
   * `initiatingDesignId` *or* the referenced `designId`, so both are
   * checked. Also tries `maybeAutoCloseThread` on each thread touched
   * (item 3, above) -- fires the moment the *second* side settles,
   * whichever order the two sides happen to resolve in.
   *
   * The note text used to be one template shared by both decisions
   * (`${decision}d`) -- "Resolved: X's design was rejectd" on a reject:
   * wrong grammar, and wrong semantics. A reject isn't a resolution --
   * `decideReview` never appends to either justified list on reject, only
   * approve does (see `isDesignSideSettled`'s own doc comment) -- it's a
   * terminal close instead, and the note now says exactly that, without
   * the "Resolved:" label. */
  function notifyAlignmentThreadsOfDecision(review: PendingReview, decision: "approve" | "reject"): void {
    const design = designs.get(review.designId);
    const who = design?.developerId ?? review.projectId;
    const note =
      decision === "approve"
        ? `Resolved: ${who}'s design was approved -- "${review.justification}"`
        : `${who}'s design was rejected and closed -- "${review.justification}". A fresh design is needed to continue that work.`;
    const openThreads = alignmentThreads.listByProject(review.projectId, "open");

    for (const w of review.conflictWaivers ?? []) {
      const thread = openThreads.find(
        (t) =>
          t.category === "llm_divergence" &&
          ((t.initiatingDesignId === review.designId && t.designId === w.conflictingDesignId) ||
            (t.designId === review.designId && t.initiatingDesignId === w.conflictingDesignId)),
      );
      if (thread) {
        alignmentThreads.postSystemMessage(thread.id, note);
        maybeAutoCloseThread(thread.id);
      }
    }
    for (const w of review.symbolConflictWaivers ?? []) {
      const thread = openThreads.find(
        (t) =>
          t.category === "symbol_conflict" &&
          ((t.initiatingDesignId === review.designId && t.designId === w.conflictingDesignId) ||
            (t.designId === review.designId && t.initiatingDesignId === w.conflictingDesignId)),
      );
      if (thread) {
        alignmentThreads.postSystemMessage(thread.id, note);
        maybeAutoCloseThread(thread.id);
      }
    }
  }

  /** Shared by `/v1/designs/:id/amend` and `/v1/designs/:id/resume`: builds
   * the merged-scope candidate and runs the full syntactic check
   * (design-checks.ts tiers 1-3) against whatever's currently live, exactly
   * like initial registration does -- neither route can be used to
   * silently launder a scope change past overlap/constraint detection.
   * Callers persist (`designs.amend`/`designs.resume`) only on a clean
   * verdict; `open` is returned too since a clean persist also needs it for
   * `runSemanticComparatorPass`. */
  function checkAmendedScope(design: DesignStatement, delta: { touches?: string[]; creates?: string[]; dependsOn?: string[]; summary?: string }) {
    const merged = mergeDesignScope(design, delta);
    // `delta.summary`, if present, is already the final appended text by
    // the time it gets here (the route computes it once via
    // appendSummaryUpdate, before calling both this check and the actual
    // persist -- see AmendRequestBody's doc comment) -- still needs to flow
    // into the re-check candidate, since design-checks.ts's Jaccard
    // summary-similarity overlap tier reads it same as any other field.
    const candidate: DesignStatement = { ...design, ...merged, ...(delta.summary !== undefined ? { summary: delta.summary } : {}) };
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

    // "symbol_conflict" (2026-08-26 terminology simplification -- see
    // DesignVerdict's doc comment, core/types.ts): the one bucket sourced
    // from real edits (Claims) rather than self-reported design scope.
    // Three finding kinds feed it -- checks.ts's textual_overlap/
    // contract_divergence (two developers' real edits colliding) and
    // design-divergence.ts's design_divergence (a real edit landing inside
    // another developer's *declared* scope, no code on their side yet).
    // Always self-approvable (no third party's rule is being overridden,
    // just a peer's work), and flags *both* sides whenever each has an
    // open design at the time -- whichever side lacks one just gets the
    // advisory notice below, same as it always has.
    const openDesignsForDivergence = designs.openDesigns(projectId);
    const openDesignForDeveloper = (developerId: string): DesignStatement | undefined =>
      openDesignsForDivergence.filter((d) => d.developerId === developerId).sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];

    /** Flags whichever side(s) have an open design, opens/amends the
     * shared alignment thread (the delivery mechanism for *why* each side
     * is blocked), and returns the finding with its thread id attached.
     * `designA`/`designB` may each independently be undefined -- a side
     * with no open design simply can't be flagged, same as today. */
    function recordSymbolConflict(finding: Finding, subKind: AlignmentSubKind, designA: DesignStatement | undefined, designB: DesignStatement | undefined): Finding {
      for (const d of [designA, designB]) {
        if (!d) continue;
        const other = d === designA ? designB : designA;
        designs.flag(d.id, "symbol_conflict", {
          conflicts: other
            ? [{ conflictingDesignId: other.id, agentLabel: other.agentLabel, overlapKind: "symbol", overlapDetail: finding.reason, conflictingSummary: other.summary, overlapPaths: [finding.symbolId] }]
            : [],
        });
      }
      // Reopen-on-new-finding fix (2026-08-28): `designA`/`designB` already
      // only ever hold a design that's `openDesigns()`-live (open/flagged --
      // see that function's own status filter), so their bare presence
      // already answers `isDesignLive` for this call site, no extra fetch
      // needed the way the async llm_divergence path (above) requires.
      const reopenEligible = !!designA || !!designB;
      const thread = alignmentThreads.findOrCreate({
        projectId,
        symbolIds: [finding.symbolId],
        developerId: finding.developerId,
        otherDeveloperId: finding.otherDeveloperId,
        designId: designB?.id,
        systemDescription: finding.reason,
        category: "symbol_conflict",
        subKind,
        summary: buildAlignmentSummary(subKind, designB?.summary ?? "", 1),
        initiatingDesignId: designA?.id,
        ts: finding.ts,
        reopenEligible,
      });
      maybeAutoCloseThread(thread.id);
      return { ...finding, threadId: thread.id };
    }

    const claimMatches: ClaimFindingMatch[] = findClaimConflicts(changed, active, edges);
    const claimFindings: Finding[] = claimMatches.map((m) =>
      recordSymbolConflict(
        m.finding,
        m.finding.kind === "contract_divergence" ? "contract_break" : "real_edit_collision",
        openDesignForDeveloper(m.finding.developerId),
        openDesignForDeveloper(m.finding.otherDeveloperId),
      ),
    );

    // Cross-session design divergence (statefulness redesign, 2026-08): the
    // first place a real Claim is checked against another session's
    // self-reported open DesignStatement, not just against other designs'
    // self-reported fields. `design` (the intruded scope's owner) is
    // already resolved by findDesignDivergences itself, so it's used
    // directly rather than re-resolved via openDesignForDeveloper.
    const divergences = findDesignDivergences(changed, openDesignsForDivergence);
    const divergenceFindings: Finding[] = divergences.map(({ finding, design }) =>
      recordSymbolConflict(finding, "scope_intrusion", openDesignForDeveloper(finding.developerId), design),
    );

    const allFindings = [...claimFindings, ...divergenceFindings];

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

  // Read-only visibility into the live, in-memory claim set (§4/§11) --
  // added for twing-monitor's design-detail view, so a session's declared
  // scope (DesignStatement.creates/touches) can be shown next to what its
  // claims actually say it touched. `store.activeClaims` already walks
  // every claim in the project; `sessionId` filtering happens here rather
  // than client-side so the dashboard never has to pull a whole project's
  // claim set just to look at one session's slice of it.
  app.get("/v1/claims", (c) => {
    const identity = c.get("identity");
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "expected ?projectId=" }, 400);
    if (!isProjectMember(identity, projectId)) {
      return c.json({ error: "not a member of this project" }, 403);
    }
    const sessionId = c.req.query("sessionId");
    let items = store.activeClaims(projectId);
    if (sessionId) items = items.filter((claim) => claim.sessionId === sessionId);
    return c.json({ items });
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

  /** Authorization for the two *mutating* alignment-thread routes (reply,
   * close): only the two parties on a thread can act on it -- this stays a
   * private, voluntary reconciliation channel between the two developers it
   * names, no admin override. Acting on someone else's reconciliation isn't
   * oversight, it's participating in a conversation you weren't part of. */
  function isThreadParty(identity: ResolvedIdentity, thread: { developerId: string; otherDeveloperId: string }): boolean {
    return noAuth || identity.developerId === thread.developerId || identity.developerId === thread.otherDeveloperId;
  }

  /** Read authorization for the two *viewing* routes (list, get): a party,
   * or a project admin. Reversed 2026-08-24 from "party-only, never a
   * bystander even a project admin" -- found live: a project admin whose
   * dashboard-login identity (`join-via-github`, e.g.
   * `206395444+someuser@users.noreply.github.com`) differs from the
   * developerId their CLI/PAT sessions actually author claims/designs under
   * (e.g. their git-email-derived `mbhattacharyarules@gmail.com`) saw *zero*
   * alignment threads in twing-monitor despite being the named party on
   * several, real from that exact PAT identity -- not a bug in
   * `isThreadParty` (it's correctly symmetric), just a channel with no
   * admin visibility at all once a person's login identity and authoring
   * identity diverge, which turns out to be the common case for anyone
   * using both the CLI and the dashboard. Reply/close stay party-only
   * (`isThreadParty` above, unchanged) -- an admin can now *see* every
   * reconciliation in their project but still can't act inside one they're
   * not named on. */
  function canViewThread(identity: ResolvedIdentity, thread: { projectId: string; developerId: string; otherDeveloperId: string }): boolean {
    // Public "observe twing getting built" demo (2026-08-28): the synthetic
    // public-viewer identity is deliberately a plain `member`, never
    // `admin` -- granting admin would also unlock GET /v1/projects/:id/invites
    // (real, redeemable invite codes) and /v1/admin/* for this project,
    // which must stay closed to an unauthenticated visitor. It's also never
    // a real thread party (no claim/design is ever authored as
    // "public-viewer"). Without this explicit allowance, canViewThread would
    // reject every thread and the Alignment threads tab would render empty
    // for every visitor -- so it gets its own narrow read-only carve-out
    // here, same shape as the GET /v1/reviews 404 guard is a narrow
    // carve-out in the other direction.
    if (identity.isPublicViewer) return true;
    return isThreadParty(identity, thread) || canManageProject(identity, thread.projectId);
  }

  // Alignment threads (statefulness redesign, 2026-08): the async,
  // never-blocking "conversation layer" for a design_divergence finding
  // (design-divergence.ts). Purely additive to the notice pipeline above --
  // no PreToolUse/deny semantics anywhere on this path, and hook/design_gate.go
  // needs no changes for any of these.
  // Paginated (monitor UI load-time fix, 2026-08-29) -- same ?before=/
  // ?limit= cursor shape as GET /v1/designs above, backed by
  // AlignmentThreadStore.listByProjectPage. The `canViewThread` filter
  // still runs *after* the page comes back, same as before this change --
  // a party-only thread being filtered out of a page just makes that page
  // smaller, it never causes a page to silently skip an item the caller
  // *can* see, since `canViewThread` only excludes, never reorders.
  app.get("/v1/alignment-threads", (c) => {
    const identity = c.get("identity");
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "expected ?projectId=" }, 400);
    if (!isProjectMember(identity, projectId)) {
      return c.json({ error: "not a member of this project" }, 403);
    }
    const status = c.req.query("status") as "open" | "closed" | "dormant" | undefined;
    const beforeParam = c.req.query("before");
    const before = beforeParam !== undefined ? Number(beforeParam) : undefined;
    if (before !== undefined && !Number.isFinite(before)) return c.json({ error: "invalid ?before=" }, 400);
    const limitParam = c.req.query("limit");
    const limit = limitParam !== undefined ? Number(limitParam) : undefined;
    if (limit !== undefined && !Number.isFinite(limit)) return c.json({ error: "invalid ?limit=" }, 400);
    const { items, nextBefore } = alignmentThreads.listByProjectPage(projectId, { status, before, limit });
    return c.json({ items: items.filter((t) => canViewThread(identity, t)), nextBefore });
  });

  app.get("/v1/alignment-threads/:id", (c) => {
    const identity = c.get("identity");
    const thread = alignmentThreads.get(c.req.param("id"));
    if (!thread) return c.json({ error: "no such thread" }, 404);
    if (!canViewThread(identity, thread)) return c.json({ error: "not a party to this thread" }, 403);
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

  // Multi-repo ExitPlanMode fallback (2026-08-18): extraction only, no
  // registration. When the hook's cwd isn't itself a git repo (a shared
  // parent of several independently-onboarded repos -- see
  // handleExitPlanModeMultiCandidate in design_gate.go), it doesn't yet
  // know which candidate project(s) a plan belongs to, so it can't call
  // /v1/designs/check (which always registers). It extracts once here,
  // partitions the resulting creates/touches by which candidate repo's
  // directory name prefixes each path, then calls /v1/designs/check's
  // structured (pre-extracted) path per matching candidate. No projectId:
  // extraction itself touches no project data, so this needs only the
  // standard /v1/* identity middleware, not authorizeProject.
  app.post("/v1/designs/extract", async (c) => {
    const body = await c.req.json<{ rawPlanText?: string }>().catch(() => null);
    if (!body || typeof body.rawPlanText !== "string" || !body.rawPlanText) {
      return c.json({ error: "expected { rawPlanText }" }, 400);
    }
    const extracted = await extractDesign(body.rawPlanText, { model: extractModel });
    return c.json(extracted);
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
      const extracted = await extractDesign(body.rawPlanText, { model: extractModel });
      creates = extracted.creates;
      touches = extracted.touches;
      dependsOn = extracted.dependsOn;
      summary = extracted.summary;
    }

    // ExitPlanMode retry dedup (§17, 2026-08-18): `handleExitPlanMode`
    // (hook/design_gate.go) has no client-side memory of a prior
    // registration and POSTs fresh `rawPlanText` on every single retry --
    // without this, every retry within one plan-mode pass registered a
    // brand-new design that structurally overlapped every prior one from
    // the same loop, needing its own human-approved justification, forever
    // (unbounded). Scoped to exactly the `rawPlanText` path -- a structured
    // `twing design register` call always creates a new row, correctly, a
    // developer registering two genuinely separate tasks in one session
    // still gets two rows and a real overlap check between them.
    //
    // Session id alone isn't a safe "same plan, retried" signal -- a
    // session can legitimately register two different plan-mode designs
    // back to back, and keying purely on sessionId would silently overwrite
    // the first one's content the moment the second's ExitPlanMode fires.
    // openPlanModeDesignForSession narrows to a *candidate* by session id;
    // the Jaccard gate below decides whether it's actually the same plan.
    let design: DesignStatement | undefined;
    let reregistered = false;
    if (body.rawPlanText) {
      const candidate = designs.openPlanModeDesignForSession(body.projectId, body.sessionId);
      if (candidate?.rawPlanExcerpt) {
        const similarity = jaccard(candidate.rawPlanExcerpt, body.rawPlanText);
        console.log(
          `twing serve: design ${candidate.id.slice(0, 8)} plan-retry similarity to session ${body.sessionId.slice(0, 12)}'s new ExitPlanMode call: ${similarity.toFixed(3)}` +
            (similarity >= PLAN_RETRY_SIMILARITY_THRESHOLD ? " -- reregistering in place" : " -- below threshold, registering fresh"),
        );
        if (similarity >= PLAN_RETRY_SIMILARITY_THRESHOLD) {
          design = designs.reregisterFromPlan(candidate.id, { summary, creates, touches, dependsOn, rawPlanExcerpt: body.rawPlanText });
          reregistered = design !== undefined;
        }
      }
    }
    // "Force a choice" registration-sprawl fix (2026-08-25) retired
    // 2026-08-31: this used to hard-block a structured `twing design
    // register` call whenever the developer had any other open design
    // anywhere, cross-project -- found live to break two completely normal
    // workflows it never accounted for: switching to an unrelated bug fix
    // mid-session without going through plan mode (the Edit/Write gate
    // needs *a* design for the new files, so `register` is the only way to
    // get one, and this then always fired), and running concurrent
    // sessions on different repos under the same identity (the check was
    // purely developerId-scoped, no session/project awareness, so the
    // second session's first registration collided with the first
    // session's every time, permanently). `ExitPlanMode` (rawPlanText)
    // already solved the same underlying problem -- a developer
    // accumulating forgotten open designs -- without blocking, via the
    // "stale sibling" notice just below: register unconditionally, then
    // nudge if a genuinely non-overlapping sibling is still open. That
    // notice was never conditioned on how registration got here, so
    // removing this block is enough on its own to give the structured
    // `register` path the exact same non-blocking behavior for free.
    design ??= designs.register({
      projectId: body.projectId,
      developerId: identity.developerId,
      sessionId: body.sessionId,
      agentLabel: body.agentLabel,
      summary,
      creates,
      touches,
      dependsOn,
      // No truncation (dropped 2026-08-18, was capped at 2000 chars) -- see
      // DesignStatement.rawPlanExcerpt's doc comment in @twing/core for why.
      rawPlanExcerpt: body.rawPlanText,
      ttlMs: body.ttlMs,
      groupId: body.groupId,
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
      // `summary`/`conflicts`/`constraints` (twing-monitor, 2026-08-19; key
      // pluralized 2026-08-22 alongside the multi-constraint fix -- the
      // dashboard needs a matching update): the dashboard's activity feed
      // used to show only a bare "overlap"/"constraint_flag" string here
      // with no way to tell *what* it overlapped or *which* constraint(s)
      // -- this is the one place `outcome`'s full detail is in scope, so it
      // rides along on the event rather than being lost the moment this
      // response is sent.
      payload: {
        verdict: outcome.verdict,
        conflictCount: outcome.conflicts.length,
        reregistered,
        summary: design.summary,
        ...(outcome.conflicts.length > 0 ? { conflicts: outcome.conflicts } : {}),
        ...(outcome.constraints.length > 0 ? { constraints: outcome.constraints } : {}),
      },
    });

    // §17 scope enforcement (2026-08): a blocking verdict demotes the
    // design out of "open" immediately -- before this response is ever
    // sent -- so it stops counting as a usable open design for the
    // Edit/Write gate's own-session check (`/v1/designs/scope-match`
    // below), rather than staying "open" until someone resolves it.
    //
    // 2026-08-26: whether a verdict blocks is now a pure function of the
    // verdict itself, not a separately-tracked severity -- `"file_overlap"`
    // (the only verdict `runDesignChecks` can return besides
    // `"constraint_violation"`/`"clean"`) never blocks; `"clean"` obviously
    // doesn't either. The conflict is still fully recorded above (activity
    // log) and in the response below either way; for `"file_overlap"` it's
    // display-only, not gate-relevant.
    if (outcome.verdict === "constraint_violation") {
      designs.flag(design.id, outcome.verdict, { conflicts: outcome.conflicts, constraints: outcome.constraints });
    }

    // §17 design lifecycle (2026-08): registering a new design is a much
    // faster, more precise signal of context-switch than any inactivity
    // window -- if this developer already has other open designs that this
    // one genuinely doesn't overlap, nudge about it. Advisory only: nothing
    // about the sibling's status/lastActivityAt changes here -- dormancy
    // stays driven by inactivity alone, this is purely informational.
    //
    // Broadened 2026-08-25 ("force a choice" registration-sprawl fix) from
    // `openDesigns(projectId, ...)` filtered to same-session, to
    // `openDesignsForDeveloper` -- cross-project and no longer
    // session-restricted (session-scoping was only ever load-bearing for an
    // earlier, abandoned ExitPlanMode-blocking approach; see this feature's
    // plan/commit message). This was originally `ExitPlanMode`'s
    // never-blocking half of that feature, with a separate hard-blocking
    // `has_open_designs` verdict for the structured `register` path above.
    // That block was retired 2026-08-31 -- found live to break normal
    // task-switching and concurrent sessions (see the removed code's git
    // history for the incident) -- so this notice is now the *entire*
    // feature for both paths: registration never blocks on this, it just
    // nudges.
    //
    // Deliberately `pathsOverlap`, not `outcome.conflicts` (2026-08-22): a
    // same-developer sibling is the same developer by construction, and
    // `outcome.conflicts` now excludes same-developer pairs entirely (see
    // design-checks.ts's top-of-file comment) -- reusing it here would make
    // every sibling look "non-overlapping" regardless of whether their
    // scopes actually collide, a wrong message, not just a missed one. A
    // cross-project sibling is never path-comparable at all, so it always
    // qualifies as "doesn't overlap" and always gets the notice.
    const staleSiblings = designs.openDesignsForDeveloper(identity.developerId, Date.now(), design.id).filter((d) => !pathsOverlap(design, d));
    for (const sibling of staleSiblings) {
      const message =
        `twing design coordinator: you also have design ${sibling.id} [${sibling.status}] open ` +
        `("${sibling.summary || "no summary"}") that this new design doesn't touch. If that work is done, ` +
        `close it: twing design close --id ${sibling.id} -- or if it's the same effort, link them: ` +
        `twing design amend --id ${design.id} --group ${sibling.id}`;
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

    // groupId (§17 design linking, 2026-08): echoed back on every branch --
    // post self-assignment, this is what lets a CLI caller that didn't pass
    // --group still see the value to hand a sibling-repo registration.
    //
    // Existence-check advisory (2026-08-31): `creates`/`touches` echoed back
    // too, but only for a `rawPlanText` (ExitPlanMode) caller -- a
    // structured `register` call already supplied these itself, so echoing
    // them back would be pure noise. The Go hook has no other way to see
    // what design-extract.ts resolved server-side (extraction never
    // reaches the caller otherwise), and needs exactly this to stat
    // `touches` against its own local `repoRoot` and warn on a likely
    // wrong-project registration -- see hook/design_gate.go's
    // `handleExitPlanModeSingle`.
    const extractedFields = body.rawPlanText ? { creates: design.creates, touches: design.touches } : {};
    if (outcome.verdict === "clean") {
      return c.json({ verdict: "clean", designId: design.id, groupId: design.groupId, ...extractedFields });
    }
    if (outcome.verdict === "constraint_violation") {
      return c.json({
        verdict: "constraint_violation",
        designId: design.id,
        groupId: design.groupId,
        constraints: outcome.constraints,
        ...extractedFields,
      });
    }
    return c.json({ verdict: "file_overlap", designId: design.id, groupId: design.groupId, conflicts: outcome.conflicts, ...extractedFields });
  });

  // §17.5: adopt the conflicting design (superseded), or justify diverging
  // (queues to /v1/reviews -- does not unblock by itself).
  app.post("/v1/designs/:id/resolve", async (c) => {
    const identity = c.get("identity");
    const id = c.req.param("id");
    const design = designs.get(id);
    if (!design) return c.json({ error: "no such design" }, 404);
    if (!isProjectMember(identity, design.projectId)) {
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
    // §17 review-flow fix (2026-08, amended 2026-08-17, widened 2026-08-22
    // to every match instead of one -- see matchConstraintsForPaths' doc
    // comment): if this design's own scope matches one or more constraints,
    // attribute the review to all of their ids so approving it can later
    // exclude them from the ground-truth backstop (justifiedConstraintIds,
    // /v1/constraints/match).
    // Originally derived this from `checkAmendedScope`'s overall verdict --
    // wrong, because `runDesignChecks` returns tier-1 "overlap" (a conflict
    // against some *other* open design) before it ever reaches tier-3's
    // constraint check, whenever both happen to be true at once. Found live
    // 2026-08-17: this design (7d65230f) genuinely touched
    // require_human_review paths (app.ts, hook/design_gate.go) *and*
    // happened to overlap another open design on those same files -- the
    // recomputed verdict came back "overlap", constraintId was silently
    // dropped, and the approved review never populated
    // justifiedConstraintIds, so the ground-truth check kept denying
    // forever even after approval -- the exact bug this design was
    // registered to fix, reproducing itself. Checking the constraint match
    // directly against the design's own creates/touches (independent of
    // whatever else is open) is immune to that -- it answers "does this
    // design's scope hit a flagged path", not "what's the single top-line
    // verdict against everything else right now".
    const constraintHits = matchConstraintsForPaths([...design.creates, ...design.touches], constraintStore.forProject(design.projectId), design.justifiedConstraintIds);
    // Item 7's fix (2026-08-18): same "recompute against current state at
    // justify-time" reasoning as constraintHits above, applied to structural
    // design-vs-design overlap -- the top-line verdict that originally
    // flagged this design isn't trusted here either. Only ever narrows to
    // the *unwaived* remainder (structuralOverlaps already excludes
    // anything in design.justifiedOverlaps), so an already-approved path
    // never re-appears in a fresh review; a genuinely new one still does.
    const structuralConflicts = structuralOverlaps(design, designs.openDesigns(design.projectId, Date.now(), design.id));
    const overlapWaivers = structuralConflicts.map((c) => ({ conflictingDesignId: c.conflictingDesignId, paths: c.overlapPaths }));
    // Semantic comparator's counterpart to overlapWaivers above (2026-08-22):
    // no cheap live recompute here (that would mean a second synchronous LLM
    // call inside this route) -- instead, read back which other designs this
    // one currently has an *open* `llm_divergence` alignment thread against.
    // 2026-08-27, both-sides blocking: `runSemanticComparatorPass` now flags
    // *both* designs in a divergent pair (mirrors symbol_conflict's existing
    // "whichever side(s) have an open design" rule -- was initiator-only
    // before, an unprincipled asymmetry with symbol_conflict, no longer
    // true). So `design.id` can legitimately be either `initiatingDesignId`
    // *or* `designId` on the thread depending on which side got flagged --
    // the `(t.initiatingDesignId === design.id || t.designId === design.id)`
    // check just below already covers both (see the 2026-08-26 "second fix"
    // note right after this comment for why that symmetric check exists at
    // all), so this needed no further change beyond the comparator itself.
    //
    // 2026-08-26 fix: this used to filter on `t.symbolId === design.id`,
    // matching `AlignmentThread.symbolId`'s doc comment calling it a
    // "legacy...design-id-stand-in field" -- true before `initiatingDesignId`
    // existed, when `symbolId` was overloaded to carry a design id for a
    // symbol-less design-vs-design finding. `runSemanticComparatorPass`
    // always passes `symbolIds: []` now, so `thread.symbolId` is always `""`
    // for these threads and this comparison could never match -- confirmed
    // dead since `initiatingDesignId` shipped: no llm_divergence resolve has
    // ever actually populated `conflictWaivers`, so `justifiedConflicts`
    // never got the approved design id and the semantic comparator kept
    // re-flagging the same pair after every approval. Caught while adding
    // `symbolConflictWaivers` below, which needed the same read-back and
    // would otherwise have copied the same dead pattern next to a working
    // one. See PendingReview.conflictWaivers' own doc comment (@twing/core).
    //
    // 2026-08-26, second fix, same day: `initiatingDesignId`-only was
    // correct back when each side of an llm_divergence pair always got its
    // *own* separate thread (each one-directional `runSemanticComparatorPass`
    // call forked a new thread, so "am I the initiator" and "do I have a
    // thread at all" were the same question). Now that `findOrCreate`
    // recognizes the reverse direction and reuses one shared thread per
    // pair (see its own doc comment, alignment-store.ts), the side that
    // *wasn't* first to trigger the check can show up as the thread's
    // `designId` instead of its `initiatingDesignId` -- same both-sides
    // shape `symbolConflictWaivers` below already has to handle, for the
    // same reason.
    const conflictWaivers = alignmentThreads
      .listByProject(design.projectId, "open")
      .filter((t) => t.category === "llm_divergence" && (t.initiatingDesignId === design.id || t.designId === design.id))
      .map((t) => ({ conflictingDesignId: (t.initiatingDesignId === design.id ? t.designId : t.initiatingDesignId)! }))
      .filter((w) => w.conflictingDesignId);
    // `symbolConflictWaivers` (2026-08-26, new bucket): unlike llm_divergence
    // above, a `symbol_conflict` finding can flag *both* sides independently
    // (`recordSymbolConflict`, app.ts's `/v1/claims` handler) -- so this
    // design can show up either as the initiator (`initiatingDesignId`) or
    // as the referenced other side (`designId`) of a thread that flagged it.
    // `symbolIds` on the thread is the accumulated set of real edits that
    // collided; that's exactly what `DesignRegistry.decideReview` needs to
    // build `justifiedSymbolConflicts`' composite waiver keys.
    const symbolConflictWaivers = alignmentThreads
      .listByProject(design.projectId, "open")
      .filter((t) => t.category === "symbol_conflict" && (t.initiatingDesignId === design.id || t.designId === design.id))
      .map((t) => ({
        conflictingDesignId: (t.initiatingDesignId === design.id ? t.designId : t.initiatingDesignId)!,
        symbolIds: t.symbolIds,
      }))
      .filter((w) => w.conflictingDesignId);
    const review = designs.addReview(
      id,
      design.projectId,
      body.justification,
      constraintHits.map((h) => h.id),
      overlapWaivers,
      conflictWaivers.length > 0 ? conflictWaivers : undefined,
      symbolConflictWaivers.length > 0 ? symbolConflictWaivers : undefined,
    );
    console.log(`twing serve: design ${id.slice(0, 8)} justified divergence -> pending review ${review.id.slice(0, 8)}`);
    // 2026-08-26 self-approve: a review that carries no constraint hit at
    // all is never overriding a third party's rule (constraint_violation is
    // the only bucket where "whoever's authority you'd be overriding" is
    // the project admin) -- so decide it immediately rather than waiting on
    // `POST /v1/reviews/:id/decide`. `decideReview` still runs its normal
    // approve path (unions the waivers into the design's justified* fields,
    // reopens the design), so a repeat of the same conflict after this
    // still gets suppressed the same way an admin-approved review always
    // has.
    if (constraintHits.length === 0) {
      designs.decideReview(review.id, "approve");
      notifyAlignmentThreadsOfDecision(review, "approve");
      return c.json({ status: "resolved", reviewId: review.id });
    }
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
    if (!isProjectMember(identity, design.projectId)) {
      return c.json({ error: "not a member of this project" }, 403);
    }
    const closed = designs.close(id);
    // Tightening alignment threads item 3 (2026-08-27): the other half of
    // maybeAutoCloseThread's two call sites -- someone closing instead of
    // resolving is just as valid a way to settle their side of a thread as
    // an approved justification is (see isDesignSideSettled's "closed"
    // branch). Every open thread naming this design, on either side, gets
    // re-checked; each individually still requires the *other* side to
    // also be settled before it actually closes.
    if (closed) {
      for (const t of alignmentThreads.listByProject(design.projectId, "open")) {
        if (t.initiatingDesignId === id || t.designId === id) maybeAutoCloseThread(t.id);
      }
    }
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
    if (!isProjectMember(identity, design.projectId)) {
      return c.json({ error: "not a member of this project" }, 403);
    }

    const body = await c.req.json<AmendRequestBody>().catch(() => null);

    // Change D (2026-08-31, design-gate registration-flow fixes): move an
    // open, never-linked, nothing-built-on-it-yet design into a different
    // project -- checked before every other branch below, since it's a
    // distinct action with its own guard, not a scope amend. Auth is
    // non-negotiable: membership in *both* the old project (already
    // checked above) and the new one, or this would be exactly the hole a
    // naive version of this feature opens -- moving a design into or out
    // of a project you're not a member of.
    if (body?.reassignProjectId !== undefined) {
      const newProjectId = body.reassignProjectId;
      if (!isProjectMember(identity, newProjectId)) {
        return c.json({ error: "not a member of the target project" }, 403);
      }
      if (design.status !== "open") {
        return c.json({ error: `design is ${design.status}, not open -- can't reassign` }, 409);
      }
      // Scoped narrowly to "nothing downstream depends on this design
      // yet" rather than a general move-at-any-point feature -- any of
      // these three existing means real process has already happened
      // against the design's *current* project, and the deny message
      // (hook/design_gate.go's warnIfTouchesMissing) already tells the
      // caller to close-and-re-register instead when this is refused.
      if (designs.hasReviewForDesign(id)) {
        return c.json({ error: "design has a review attached -- close and re-register instead of reassigning" }, 409);
      }
      if (alignmentThreads.hasThreadForDesign(id)) {
        return c.json({ error: "design has an alignment thread attached -- close and re-register instead of reassigning" }, 409);
      }
      if (design.groupId && designs.listByGroup(design.groupId).length > 1) {
        return c.json({ error: "design is linked to another design -- close and re-register instead of reassigning" }, 409);
      }

      // Re-run the full syntactic check against the *new* project's own
      // open designs/constraints before persisting anything -- the design
      // needs to be evaluated against where it would actually live, not
      // silently trusted. Unlike scope-amend's persist-then-flag (this
      // route, below), a non-clean verdict here leaves the design exactly
      // where it was: the guard above already established nothing depends
      // on this design's current state, so there's nothing to lose by
      // simply refusing the move outright rather than landing it under
      // the new project already flagged.
      const openInNewProject = designs.openDesigns(newProjectId, Date.now(), design.id);
      const constraintsInNewProject = constraintStore.forProject(newProjectId);
      const outcome = runDesignChecks(design, openInNewProject, constraintsInNewProject);
      if (outcome.verdict !== "clean") {
        console.log(`twing serve: design ${id.slice(0, 8)} reassign to project ${newProjectId.slice(0, 12)} refused -> ${outcome.verdict}`);
        return c.json({ verdict: outcome.verdict, designId: id, conflicts: outcome.conflicts, constraints: outcome.constraints });
      }

      const reassigned = designs.reassignProject(id, newProjectId);
      if (!reassigned) return c.json({ error: "no such design" }, 404);
      console.log(`twing serve: design ${id.slice(0, 8)} reassigned ${design.projectId.slice(0, 12)} -> ${newProjectId.slice(0, 12)}`);
      return c.json({ verdict: "clean", designId: reassigned.id, projectId: reassigned.projectId });
    }

    // §17 design linking follow-up (2026-08-28): a groupId-only delta (no
    // scope or summary change) is pure metadata, not a scope expansion --
    // route it to DesignRegistry.relink() instead, which works regardless
    // of status (see relink()'s own doc comment for why that's safe). This
    // has to be checked before the "must be open" gate below, since its
    // whole purpose is letting a *closed* design join a group. Every other
    // amend shape (any actual scope/summary change) falls through
    // unchanged to the existing open-only path.
    const hasScopeChange = Boolean((body?.addTouches?.length ?? 0) > 0 || (body?.addCreates?.length ?? 0) > 0 || (body?.addDependsOn?.length ?? 0) > 0 || body?.summary !== undefined);
    if (body?.groupId !== undefined && !hasScopeChange) {
      const relinked = designs.relink(id, body.groupId);
      if (!relinked) return c.json({ error: "no such design" }, 404);
      return c.json({ verdict: "clean", designId: relinked.id, groupId: relinked.groupId });
    }

    if (design.status !== "open") {
      return c.json({ error: `design is ${design.status}, not open -- can't amend` }, 409);
    }

    // Computed once, here -- not inside checkAmendedScope/designs.amend
    // individually -- so the pre-persist check and the actual persist act
    // on the exact same final string rather than each independently calling
    // appendSummaryUpdate (which embeds the current date) and risking a
    // divergent result between "what got checked" and "what got saved".
    const summary = body?.summary !== undefined ? appendSummaryUpdate(design.summary, body.summary) : undefined;
    const delta = {
      touches: body?.addTouches ?? [],
      creates: body?.addCreates ?? [],
      dependsOn: body?.addDependsOn ?? [],
      summary,
      // §17 design linking (2026-08): the raw, un-appended update text --
      // `summary` above is already the *final merged* string for this one
      // design; `designs.amend`'s groupId fan-out needs the raw text
      // instead, so each linked sibling can independently append the same
      // update onto its own summary rather than being overwritten with
      // this design's merged one. See DesignRegistry.amend's `summaryUpdate`
      // param doc comment.
      summaryUpdate: body?.summary,
      groupId: body?.groupId,
    };
    if (delta.touches.length === 0 && delta.creates.length === 0 && delta.dependsOn.length === 0 && delta.summary === undefined && delta.groupId === undefined) {
      return c.json({ error: "expected at least one of addTouches/addCreates/addDependsOn/summary/groupId" }, 400);
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
      // 2026-08-26: blocking is now a static function of `verdict` alone
      // (see DesignVerdict's doc comment, core/types.ts) -- `file_overlap`
      // (tier 1) stays advisory, already persisted above via designs.amend,
      // surfaced here for display only; `constraint_violation` (tier 3)
      // always flags out of "open".
      const action = outcome.verdict === "constraint_violation" ? "rejected" : "flagged (advisory only)";
      console.log(`twing serve: design ${id.slice(0, 8)} amend ${action} -> ${outcome.verdict}`);
      // Found while updating twing-monitor for the severity split: a
      // non-blocking amend previously left *no* activity record at all --
      // designs.flag()'s design_flagged event (the only place this outcome
      // ever got logged) is skipped when nothing gets flagged, and
      // designs.amend()'s own design_amended event only ever carries the
      // scope delta, never the check outcome. Logged here unconditionally
      // (matching registration's own design_checked, which fires regardless
      // of verdict) so both cases leave a "why" a viewer can find.
      activityLog.append({
        projectId: design.projectId,
        developerId: identity.developerId,
        sessionId: design.sessionId,
        kind: "design_checked",
        relatedId: id,
        ts: Date.now(),
        payload: {
          verdict: outcome.verdict,
          summary: amended.summary,
          ...(outcome.conflicts.length > 0 ? { conflicts: outcome.conflicts } : {}),
          ...(outcome.constraints.length > 0 ? { constraints: outcome.constraints } : {}),
        },
      });
      if (outcome.verdict === "constraint_violation") {
        designs.flag(id, outcome.verdict, { conflicts: outcome.conflicts, constraints: outcome.constraints });
      }
      runSemanticComparatorPass(id, open);
      return c.json({ verdict: outcome.verdict, designId: id, groupId: amended.groupId, conflicts: outcome.conflicts, constraints: outcome.constraints });
    }

    console.log(`twing serve: design ${id.slice(0, 8)} amended -> scopeVersion ${amended.scopeVersion}`);
    runSemanticComparatorPass(amended.id, open);
    return c.json({ verdict: "clean", designId: amended.id, groupId: amended.groupId });
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
    if (!isProjectMember(identity, design.projectId)) {
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

    // Tightening alignment threads item 4 (2026-08-27): the symmetric
    // wake-up for maybeDormThread above -- unconditional (doesn't wait to
    // see whether this resume even comes back clean below), since the
    // design itself just left "dormant" either way, and a dormant thread
    // naming it is exactly as stale as the design it was demoted alongside.
    for (const t of alignmentThreads.listByProject(resumed.projectId, "dormant")) {
      if (t.initiatingDesignId === id || t.designId === id) {
        alignmentThreads.postSystemMessage(t.id, `Reopened: ${resumed.developerId}'s design was resumed.`);
        alignmentThreads.wake(t.id);
      }
    }

    if (outcome.verdict !== "clean") {
      // Same 2026-08-26 static-per-verdict blocking as amend above -- a
      // `file_overlap` stays "open" (designs.resume already persisted it
      // above), only `constraint_violation` flags.
      const action = outcome.verdict === "constraint_violation" ? "rejected" : "flagged (advisory only)";
      console.log(`twing serve: design ${id.slice(0, 8)} resume ${action} -> ${outcome.verdict}`);
      // Same activity-trail gap as amend above -- a non-blocking resume
      // previously left no record at all of what it found, since
      // design_flagged is skipped and design_resume's own event (below)
      // doesn't carry verdict/conflicts.
      activityLog.append({
        projectId: resumed.projectId,
        developerId: resumed.developerId,
        sessionId: resumed.sessionId,
        kind: "design_checked",
        relatedId: id,
        ts: Date.now(),
        payload: {
          verdict: outcome.verdict,
          summary: resumed.summary,
          ...(outcome.conflicts.length > 0 ? { conflicts: outcome.conflicts } : {}),
          ...(outcome.constraints.length > 0 ? { constraints: outcome.constraints } : {}),
        },
      });
      if (outcome.verdict === "constraint_violation") {
        designs.flag(id, outcome.verdict, { conflicts: outcome.conflicts, constraints: outcome.constraints });
      }
      runSemanticComparatorPass(id, open);
      return c.json({ verdict: outcome.verdict, designId: id, conflicts: outcome.conflicts, constraints: outcome.constraints });
    }

    console.log(`twing serve: design ${id.slice(0, 8)} resumed by ${identity.developerId.slice(0, 12)}/${body.sessionId.slice(0, 12)}`);
    runSemanticComparatorPass(resumed.id, open);
    return c.json({ verdict: "clean", designId: resumed.id });
  });

  // Visibility/debugging (§17.2). Was also what the hook's Edit|Write gate
  // used to check "is there an open design for my session" -- superseded by
  // /v1/designs/scope-match below (§17 scope enforcement, 2026-08), which
  // additionally checks the specific file against that design's own scope.
  // twing-monitor v1: DesignsView's card list (and, via the same client
  // code, the public "observe" route). Paginated (monitor UI load-time
  // fix, 2026-08-29) -- ?before=/?limit= mirror GET /v1/activity's own
  // cursor shape, backed by DesignRegistry.listByProjectPage (see its own
  // doc comment for why this is a separate method from the unpaginated
  // listByProject every other caller in this file still uses).
  // ?developerId= is new here: lets DesignsView's "mine only" toggle
  // filter server-side instead of client-side, which pagination requires
  // for correctness (a client-side filter over one page can look wrongly
  // empty while more matching rows sit on later pages).
  app.get("/v1/designs", (c) => {
    const identity = c.get("identity");
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "expected ?projectId=" }, 400);
    if (!isProjectMember(identity, projectId)) {
      return c.json({ error: "not a member of this project" }, 403);
    }
    const status = c.req.query("status") as DesignStatement["status"] | undefined;
    const sessionId = c.req.query("sessionId") || undefined;
    const developerId = c.req.query("developerId") || undefined;
    const beforeParam = c.req.query("before");
    const before = beforeParam !== undefined ? Number(beforeParam) : undefined;
    if (before !== undefined && !Number.isFinite(before)) return c.json({ error: "invalid ?before=" }, 400);
    const limitParam = c.req.query("limit");
    const limit = limitParam !== undefined ? Number(limitParam) : undefined;
    if (limit !== undefined && !Number.isFinite(limit)) return c.json({ error: "invalid ?limit=" }, 400);
    const { items, nextBefore } = designs.listByProjectPage(projectId, { status, sessionId, developerId, before, limit });
    return c.json({ items, nextBefore });
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
  //  - "flagged": something's registered, but its own verdict wasn't clean
  //    (DesignRegistry.flag) -- resolve it before it counts as usable.
  //    Checked *before* "dormant" (found live, 2026-08-26 -- see the fix
  //    note below): a flagged design is an active block, possibly
  //    admin-gated, on work this session actually registered; a dormant
  //    design is just idle, parked work nobody's asked to resume. Ranking
  //    "idle" above "actively blocked" meant a session carrying any dormant
  //    design at all could never learn about a real flagged/pending-review
  //    block sitting right next to it -- it always got told to `design
  //    resume` the dormant one instead, which silently reactivates
  //    unrelated stale work while hiding the actual blocker.
  //  - "dormant" (§17 design lifecycle, 2026-08): no open or flagged design
  //    (matching or not), but a dormant one exists -- never silently
  //    allowed or woken; points at `twing design resume`, which re-checks
  //    against whatever's live before reactivating anything.
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
      // Found live (2026-08-25): with more than one open design for this
      // session, this used to hand back `openOnes[openOnes.length - 1]` --
      // since `openOnes` inherits `listByProject`'s newest-first order
      // (design-store.ts), that's the *oldest* open design, not the most
      // recently registered/active one. A single-candidate guess should at
      // least guess the most likely one; `designId` here is now
      // `openOnes[0]`, the newest. `openDesigns` is new -- every open
      // candidate for this session (still newest-first), so the caller
      // (the Go hook's deny message) can offer all of them instead of
      // silently picking just one.
      return c.json({
        state: "out_of_scope",
        designId: openOnes[0].id,
        openDesigns: openOnes.map((d) => ({ id: d.id, summary: d.summary })),
      });
    }

    // Checked before "dormant" -- see this endpoint's own doc comment above
    // for why an active block outranks idle/parked work. pendingReview
    // distinguishes "never resolved" from "resolved, an admin just hasn't
    // decided yet" (found live, 2026-08-16) -- both used to render as the
    // identical deny telling you to run `twing design resolve`, even right
    // after you'd already done so.
    const flaggedOnes = sessionDesigns.filter((d) => d.status === "flagged");
    if (flaggedOnes.length > 0) {
      // The block itself is session-wide, not scoped to `path` -- once no
      // open design covers the file, any unresolved flagged design blocks
      // regardless of what it declared. But which *one* gets named in the
      // deny message is still worth getting right when there's more than
      // one: same "prefer an actual scope match, only then fall back to
      // newest" shape as `openOnes`/`dormantOnes` above (found live,
      // 2026-08-26) -- naming the flagged design that's actually about
      // `path` is a more actionable deny than always naming whichever was
      // flagged most recently, which could be about an unrelated file.
      const flaggedDesign = (path && flaggedOnes.find((d) => pathInDesignScope(path, d))) || flaggedOnes[0];
      // requiresAdmin (2026-08-26) + verdict (2026-08-26, second pass): which
      // of the two self-approvable buckets vs. the one admin-gated bucket
      // actually flagged this design. Previously reconstructed by reading
      // back the design's `design_flagged` activity events, since
      // `designs.flag()` only stamped `verdict` onto that event's payload,
      // never the design row itself -- `blockedReason` (core/types.ts) now
      // carries it directly, set by the same `flag()` call, so this is a
      // plain field read instead of an activity-log join. Lets the Go hook's
      // deny message tell "justify it and you're unblocked immediately"
      // apart from "this goes to a project admin," and now name the actual
      // reason instead of one generic sentence for all three buckets -- see
      // DesignVerdict's doc comment (core/types.ts) for the full four-bucket
      // model.
      const requiresAdmin = flaggedDesign.blockedReason === "constraint_violation";
      return c.json({
        state: "flagged",
        designId: flaggedDesign.id,
        pendingReview: designs.hasPendingReview(flaggedDesign.id),
        requiresAdmin,
        verdict: flaggedDesign.blockedReason,
      });
    }

    // Only dormant designs remain, since sessionDesigns was non-empty and
    // openOnes/flaggedOnes were both empty.
    const dormantOnes = sessionDesigns.filter((d) => d.status === "dormant");
    const now = Date.now();
    // Same newest-first pick as above -- `dormantOnes[0]`, not
    // `[dormantOnes.length - 1]` (found live, 2026-08-26, same bug class).
    const named = (path && dormantOnes.find((d) => pathInDesignScope(path, d))) || dormantOnes[0];
    return c.json({ state: "dormant", designId: named.id, summary: named.summary, dormantSinceMs: now - named.lastActivityAt });
  });

  // Single-design fetch (monitor UI load-time fix, 2026-08-29): added so
  // the dashboard's copy-link/jump-to-design focus page and its
  // semantic-overlap-counterpart lookups no longer need to pull every
  // design in a project just to resolve one id -- see DesignsView.tsx's
  // own comments for the two call sites this replaces. `groupMembers` is
  // every other design sharing this one's `groupId` (§17 design linking,
  // via the existing `listByGroup`) that the caller is authorized to see --
  // filtered per-sibling since a linked group can span projects; a sibling
  // in a project the caller can't see is silently omitted, not a 403 for
  // the whole request. `isProjectMember` already handles the public
  // "observe" viewer correctly here (its identity's `projects` list *is*
  // `publicProjectIds`), same as every other route on this path.
  // MUST be registered after every other static /v1/designs/<literal> GET
  // route above (scope-match) -- Hono matches routes in registration
  // order, and a bare `:id` segment would otherwise swallow a literal path
  // like `scope-match` before it ever reaches its real handler (found
  // live, via a full scope-match test regression, while building this).
  app.get("/v1/designs/:id", (c) => {
    const identity = c.get("identity");
    const design = designs.get(c.req.param("id"));
    if (!design || !isProjectMember(identity, design.projectId)) return c.json({ error: "no such design" }, 404);
    const groupMembers = design.groupId ? designs.listByGroup(design.groupId).filter((d) => d.id !== design.id && isProjectMember(identity, d.projectId)) : [];
    return c.json({ design, groupMembers });
  });

  // §17.5: the human-facing queue -- justified divergences pending sign-off.
  // twing-monitor v1: ?status= (pending/decided/all, defaults to pending --
  // unchanged from before this query param existed) lets ReviewsView also
  // show decided history, not just the live queue.
  app.get("/v1/reviews", (c) => {
    const identity = c.get("identity");
    // Public "observe twing getting built" demo (2026-08-28): excluded
    // outright rather than filtered -- a pending review's own
    // justification text can be more candid than a design summary ever
    // is, and there's no version of this route's response that's fine to
    // show a stranger. 404, not 403, so it reads as "this doesn't exist
    // here" rather than inviting a login attempt.
    if (identity.isPublicViewer) return c.json({ error: "not available" }, 404);
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "expected ?projectId=" }, 400);
    if (!isProjectMember(identity, projectId)) {
      return c.json({ error: "not a member of this project" }, 403);
    }
    const status = c.req.query("status") ?? "pending";
    if (status !== "pending" && status !== "decided" && status !== "all") {
      return c.json({ error: "expected ?status= to be pending, decided, or all" }, 400);
    }
    const beforeParam = c.req.query("before");
    const before = beforeParam !== undefined ? Number(beforeParam) : undefined;
    if (before !== undefined && !Number.isFinite(before)) return c.json({ error: "invalid ?before=" }, 400);
    const limitParam = c.req.query("limit");
    const limit = limitParam !== undefined ? Number(limitParam) : undefined;
    if (limit !== undefined && !Number.isFinite(limit)) return c.json({ error: "invalid ?limit=" }, 400);
    // Enriched (2026-08-25): a bare review row names the argument for
    // letting work through without naming the work, so a reviewer had
    // nothing to decide on. Assembled per request from rows that already
    // exist -- no schema change, and no stored copy that could drift from
    // the design it describes. Every added field is optional, so an older
    // dashboard reading this is unaffected. See review-enrich.ts.
    // Paginated (monitor UI load-time fix, 2026-08-29) -- same ?before=/
    // ?limit= cursor shape as designs/alignment-threads above, backed by
    // DesignRegistry.listReviewsPage.
    const { items: page, nextBefore } = designs.listReviewsPage(projectId, { filter: status, before, limit });
    const items = enrichReviews(
      page,
      (id) => designs.get(id),
      (id) => constraintStore.get(id),
    );
    return c.json({ items, nextBefore });
  });

  // Single-review fetch (monitor UI load-time fix, 2026-08-29): added so
  // ReviewsView's copy-link/jump-to-review focus page no longer needs to
  // pull every review in a project just to resolve one id. Same
  // isPublicViewer 404 exclusion as GET /v1/reviews above (a pending
  // review's justification text can be more candid than a design summary
  // ever is), same enrichReviews treatment as the list route.
  app.get("/v1/reviews/:id", (c) => {
    const identity = c.get("identity");
    if (identity.isPublicViewer) return c.json({ error: "not available" }, 404);
    const review = designs.getReview(c.req.param("id"));
    if (!review || !isProjectMember(identity, review.projectId)) return c.json({ error: "no such review" }, 404);
    const [enriched] = enrichReviews(
      [review],
      (id) => designs.get(id),
      (id) => constraintStore.get(id),
    );
    return c.json({ item: enriched });
  });

  // twing-monitor v1: the dashboard's ActivityView -- newest-first,
  // paginated via ?before= (ms epoch, exclusive), ?limit= (default 50, hard
  // cap 200 -- enforced in eventsForProjectPage), and an optional
  // comma-separated ?kind= allowlist. `nextBefore` in the response is the
  // oldest returned event's `ts`, present only when there may be more
  // history past this page.
  app.get("/v1/activity", (c) => {
    const identity = c.get("identity");
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "expected ?projectId=" }, 400);
    if (!isProjectMember(identity, projectId)) {
      return c.json({ error: "not a member of this project" }, 403);
    }
    const beforeParam = c.req.query("before");
    const before = beforeParam !== undefined ? Number(beforeParam) : undefined;
    if (before !== undefined && !Number.isFinite(before)) return c.json({ error: "invalid ?before=" }, 400);
    const limitParam = c.req.query("limit");
    const limit = limitParam !== undefined ? Number(limitParam) : undefined;
    if (limit !== undefined && !Number.isFinite(limit)) return c.json({ error: "invalid ?limit=" }, 400);
    const kindParam = c.req.query("kind");
    const kinds = kindParam ? (kindParam.split(",") as ActivityEventKind[]) : undefined;
    const developerId = c.req.query("developerId") || undefined;
    const relatedId = c.req.query("relatedId") || undefined;
    const { items, nextBefore } = activityLog.eventsForProjectPage(projectId, { before, limit, kinds, developerId, relatedId });
    return c.json({ items, nextBefore });
  });

  // twing-monitor v1: the dashboard's ConstraintsView -- read-only reference
  // for "what canonical_abstraction/review_required rules exist here."
  // Thin wrapper: `ConstraintStore.forProject` already existed (used
  // internally by the check/match tiers), just never had a route of its own.
  app.get("/v1/constraints", (c) => {
    const identity = c.get("identity");
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "expected ?projectId=" }, 400);
    if (!isProjectMember(identity, projectId)) {
      return c.json({ error: "not a member of this project" }, 403);
    }
    return c.json({ items: constraintStore.forProject(projectId) });
  });

  // Unilateral admin deletion -- same immediate-effect, admin-gated shape
  // /v1/constraints/seed already has for add/update (ConstraintStore.add),
  // just extended to cover removal (ConstraintStore.remove). Deliberately
  // NOT the staged/approval redesign tracked separately as follow-up work
  // (an admin proposes, a *different* admin approves before it takes
  // effect) -- this is "any project admin can act immediately," matching
  // how seeding already behaves today. Fetch-then-authorize-then-mutate,
  // same order /v1/designs/:id/close uses -- the constraint's own
  // projectId (not a caller-supplied one) is what the admin check runs
  // against, so a caller can't authorize against a project they *do*
  // manage to delete a constraint that actually belongs to one they don't.
  app.delete("/v1/constraints/:id", (c) => {
    const identity = c.get("identity");
    const id = c.req.param("id");
    const existing = constraintStore.get(id);
    if (!existing) return c.json({ error: "no such constraint" }, 404);
    if (!canManageProject(identity, existing.projectId)) {
      return c.json({ error: "not an admin of this project" }, 403);
    }
    const removed = constraintStore.remove(id);
    console.log(`twing serve: constraint ${id.slice(0, 8)} removed by ${identity.developerId}`);
    return c.json({ removed: Boolean(removed) });
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
    if (decided) notifyAlignmentThreadsOfDecision(decided, body.decision);
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
    const github = body.githubOwner && body.githubRepo ? { owner: body.githubOwner, repo: body.githubRepo } : undefined;
    const authz = authorizeProject(identity, projectId, github);
    if (!authz.ok) return c.json({ error: authz.error }, authz.status);
    if (alreadyFounded && !canManageProject(identity, projectId)) {
      return c.json({ error: "not an admin of this project -- constraint changes to an existing project require admin role" }, 403);
    }

    // 2026-08-26: `entry.type` is accepted on the wire for backward
    // compatibility (old CLI builds still send it) but no longer branches
    // on anything -- `DesignConstraintType` collapsed to the single value
    // "constraint" (see DesignVerdict's doc comment in core/types.ts).
    const added = body.constraints.map((entry) => constraintStore.add(projectId, entry.statement, entry.scope, "constraint", "seeded"));
    return c.json({ seeded: added.length });
  });

  // §17 Phase 3: GitHub-verified project join -- structurally independent
  // of the invite system (no invite code, no invite table involved).
  // Works both authenticated (an existing developer attaching a second
  // project's membership to their already-cached PAT) and unauthenticated
  // (a brand-new developer presenting a freshly-generated token's hash),
  // same dual-mode shape as /v1/invites/:code/redeem above. The GitHub
  // token itself is used exactly once, right here, to ask GitHub's own API
  // what this developer can actually do on this repo -- never trusted as a
  // client-supplied claim, and never persisted anywhere on this side.
  //
  // §17 Phase 3 GitHub-founding (2026-08-17): this route now also founds a
  // brand-new project (no org, no invite/admin-bootstrap needed at all) the
  // first time anyone with real `admin`/`maintain` GitHub permission on the
  // bound repo calls it -- this is what makes plain `twing init` the only
  // command anyone ever needs, whether they're the very first person to
  // touch this project on this coordinator or the hundredth. `pull`/
  // `triage`/`push`-only callers can join an already-founded project but
  // can't found one; the founding threshold is the same `admin`/`maintain`
  // bar that already decides who gets twing `admin` on join.
  app.post("/v1/projects/:id/join-via-github", async (c) => {
    const projectId = c.req.param("id");
    const body = await c.req.json<JoinViaGithubRequestBody>().catch(() => null);
    if (!body || !body.githubToken) {
      return c.json({ error: "expected { githubToken, ... }" }, 400);
    }

    const project = identities.getProjectRecord(projectId);
    let owner: string, repo: string;
    if (project) {
      if (!project.githubOwner || !project.githubRepo) {
        return c.json({ error: "this project has no GitHub repo binding -- GitHub-verified join isn't available for it" }, 404);
      }
      // Ground truth for an already-founded project is what's on file, never
      // a client-supplied claim -- otherwise a caller with real admin on
      // some *other* repo they control could claim it against an unrelated
      // project's id to phish their way into a role there.
      owner = project.githubOwner;
      repo = project.githubRepo;
    } else {
      if (!body.githubOwner || !body.githubRepo) {
        return c.json({ error: "this project isn't founded yet -- expected { githubOwner, githubRepo } to found it" }, 400);
      }
      // Self-attested, same trust level /v1/constraints/seed's founding
      // path already extends the client for exactly this reason: there's no
      // stored binding yet for anything to check this against, and the
      // permission check right below is what actually gates founding, not
      // this claim by itself.
      owner = body.githubOwner;
      repo = body.githubRepo;
    }

    const permissions = await fetchRepoPermissions(body.githubToken, owner, repo);
    if (!permissions || !permissions.pull) {
      return c.json({ error: "this GitHub token doesn't have access to this repo" }, 403);
    }
    const role: Role = permissions.maintain || permissions.admin ? "admin" : "member";

    const header = c.req.header("authorization") ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    const existing = bearer ? identities.resolveToken(bearer) : undefined;

    const params = existing
      ? { developerId: existing.developerId }
      : body.tokenHash && body.label
        ? { tokenHash: body.tokenHash, label: body.label }
        : undefined;
    if (!params) {
      return c.json({ error: "expected { tokenHash, label } when not already authenticated" }, 400);
    }

    if (!project) {
      if (role !== "admin") {
        return c.json(
          { error: `this project isn't founded on this coordinator yet, and your GitHub permissions on ${owner}/${repo} aren't admin/maintain -- ask whoever administers that repo to run \`twing init\` first` },
          403,
        );
      }
      const founded = identities.foundProjectViaGithub(projectId, params, { owner, repo });
      if ("error" in founded) return c.json(founded, 400);
      console.log(`twing serve: ${founded.developerId} founded project ${projectId.slice(0, 12)} via GitHub (${owner}/${repo})`);
      return c.json({ developerId: founded.developerId, role: "admin", founded: true });
    }

    const result = identities.joinProject(projectId, role, params);
    if ("error" in result) return c.json(result, 400);
    console.log(`twing serve: ${result.developerId} joined project ${projectId.slice(0, 12)} via GitHub as ${role}`);
    return c.json({ ...result, role, founded: false });
  });

  // §17.9: the ground-truth backstop. Checks one literal path against the
  // Constraint Store directly -- no design registration involved, so it
  // can't be sidestepped by a session whose registered design just never
  // happens to mention the path it's about to edit. Called by the
  // Edit|Write gate on every tool call, ahead of (and independent of) the
  // "does this session have an open design at all" check.
  //
  // sessionId fix (2026-08-17): found live -- a constraint already
  // justified *and approved* for this session's own open design still
  // denied every subsequent edit forever, because this route never
  // consulted a design's `justifiedConstraintIds` at all. Optional
  // sessionId lets it now exclude constraints already reviewed and
  // approved for the caller's own currently-*open* design (matching
  // constraintMatch's tier-3 registration-time check, design-checks.ts) --
  // omitting it (or having no matching open design) reproduces the exact
  // original behavior, so the anti-bypass property this route exists for
  // is unchanged: a design that never mentions the path, or was never
  // justified, still gets caught every time.
  app.get("/v1/constraints/match", (c) => {
    const identity = c.get("identity");
    const projectId = c.req.query("projectId");
    const path = c.req.query("path");
    if (!projectId || !path) {
      return c.json({ error: "expected ?projectId=&path=" }, 400);
    }
    const authz = authorizeProject(identity, projectId);
    if (!authz.ok) return c.json({ error: authz.error }, authz.status);

    const sessionId = c.req.query("sessionId");
    let excludeConstraintIds: string[] = [];
    if (sessionId) {
      // Found live, 2026-08-26: this used to filter to `d.status === "open"`
      // only, so a design that had *already* been approved for this exact
      // constraint (durably recorded in its own `justifiedConstraintIds`,
      // set once by `decideReview(..., "approve")` and never revoked) lost
      // that exemption the instant it got re-flagged for anything else --
      // e.g. a later, unrelated `symbol_conflict` from ongoing background
      // activity in another session. The design's approval history didn't
      // change; this endpoint just stopped looking at it, so the same
      // already-approved constraint started matching again as if it had
      // never been cleared. Same eligibility filter `/v1/designs/scope-match`
      // already uses for "this session's own live designs" (open, flagged,
      // or dormant -- never closed/superseded/expired, whose justification
      // history is moot since the design itself is done) -- a design being
      // temporarily blocked for an unrelated reason should never erase an
      // already-granted, unrelated approval.
      const sessionDesigns = designs
        .listByProject(projectId)
        .filter((d) => d.sessionId === sessionId && (d.status === "open" || d.status === "flagged" || d.status === "dormant"));
      excludeConstraintIds = [...new Set(sessionDesigns.flatMap((d) => d.justifiedConstraintIds))];
    }

    const hits = matchConstraintsForPaths([path], constraintStore.forProject(projectId), excludeConstraintIds);
    if (hits.length > 0) {
      console.log(
        `twing serve: constraint match on ${path} (project ${projectId.slice(0, 12)}) -- ${hits.length} hit(s): ` +
          hits.map((h) => `${h.type}: ${h.statement}`).join(" | "),
      );
    }
    return c.json({ matched: hits.length > 0, constraints: hits });
  });

  return app;
}
