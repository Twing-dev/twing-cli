import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { Claim } from "@twing/core";
import { createApp } from "./app.js";
import { createDb } from "./db/client.js";
import { IdentityStore } from "./identity-store.js";
import { Store } from "./store.js";
import { DesignRegistry, ConstraintStore } from "./design-store.js";
import { AlignmentThreadStore } from "./alignment-store.js";

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function withMockFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

function withBedrockEnv<T>(run: () => Promise<T>): Promise<T> {
  const originalToken = process.env.AWS_BEARER_TOKEN_BEDROCK;
  const originalRegion = process.env.AWS_REGION;
  process.env.AWS_BEARER_TOKEN_BEDROCK = "test-token";
  process.env.AWS_REGION = "us-east-1";
  return run().finally(() => {
    if (originalToken === undefined) delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    else process.env.AWS_BEARER_TOKEN_BEDROCK = originalToken;
    if (originalRegion === undefined) delete process.env.AWS_REGION;
    else process.env.AWS_REGION = originalRegion;
  });
}

/** POST /v1/designs/check's semantic-conflict pass runs fire-and-forget
 * (app.ts deliberately doesn't await it -- see that handler's comment), so
 * tests poll for its side effects rather than finding them in the response
 * body. Mocked `fetch` resolves near-instantly, so this settles in one or
 * two ticks in practice -- the timeout is a generous ceiling, not the
 * expected wait. */
async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 1000, intervalMs = 5): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor: predicate never became true within ${timeoutMs}ms`);
}

function freshApp(options: { corsOrigins?: string[]; version?: string; publicProjectIds?: string[] } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "twing-app-test-"));
  // In-memory DB for speed -- these tests don't need cross-instance
  // persistence (that's design-store.test.ts/identity-store.test.ts's job).
  // The bootstrap-token file still needs a real dataDir regardless.
  const db = createDb({ memory: true });
  const identities = new IdentityStore(db, { dataDir });
  const store = new Store(db);
  const designs = new DesignRegistry(db);
  const constraints = new ConstraintStore(db);
  const alignmentThreads = new AlignmentThreadStore(db);
  const app = createApp({
    db,
    identities,
    store,
    designs,
    constraints,
    alignmentThreads,
    corsOrigins: options.corsOrigins,
    version: options.version,
    publicProjectIds: options.publicProjectIds,
  });
  return { app, dataDir, identities, store, designs, constraints, alignmentThreads };
}

function bootstrapToken(dataDir: string): string {
  return fs.readFileSync(path.join(dataDir, "bootstrap-token"), "utf8").trim();
}

/** Bootstraps the first admin over HTTP (not the store directly) so route
 * tests exercise the real request/response path end to end. Returns the
 * plaintext PAT to use as a bearer token. */
async function bootstrapAdmin(app: ReturnType<typeof createApp>, dataDir: string, label = "alice@example.com") {
  const pat = "alices-pat";
  const res = await app.request("/v1/admin/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bootstrapToken: bootstrapToken(dataDir), tokenHash: sha256Hex(pat), label }),
  });
  const body = (await res.json()) as { developerId?: string; orgId?: string; error?: string };
  assert.equal(res.status, 200, `bootstrap should succeed: ${body.error ?? JSON.stringify(body)}`);
  return { token: pat, developerId: body.developerId!, orgId: body.orgId! };
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

test("POST /v1/admin/bootstrap: succeeds with the real bootstrap token, then GET /v1/auth/whoami confirms identity", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  const res = await app.request("/v1/auth/whoami", { headers: bearer(admin.token) });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { developerId: string; orgs: { orgId: string; role: string }[] };
  assert.equal(body.developerId, "alice@example.com");
  assert.deepEqual(body.orgs, [{ orgId: admin.orgId, role: "admin" }]);
});

test("POST /v1/admin/bootstrap: rejects a wrong bootstrap token", async () => {
  const { app } = freshApp();
  const res = await app.request("/v1/admin/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bootstrapToken: "wrong", tokenHash: sha256Hex("x"), label: "alice@example.com" }),
  });
  assert.equal(res.status, 400);
});

test("unauthenticated requests to a protected route are rejected with 401", async () => {
  const { app } = freshApp();
  const res = await app.request("/v1/claims", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: "p1", claims: [] }),
  });
  assert.equal(res.status, 401);
});

function makeClaim(overrides: Partial<Claim> = {}): Claim {
  return {
    projectId: "p1",
    developerId: "someone-else@attacker.example",
    sessionId: "s1",
    branch: "main",
    symbolId: "src/x.ts::f",
    kind: "write",
    stage: "firm",
    ts: Date.now(),
    ttlMs: 6 * 60 * 60 * 1000,
    ...overrides,
  };
}

test("POST /v1/claims: self-service founds a never-seen project, and stamps developerId from the authenticated identity -- not whatever the client sent", async () => {
  const { app, dataDir, store } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  const res = await app.request("/v1/claims", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", claims: [makeClaim({ projectId: "proj-1" })] }),
  });
  assert.equal(res.status, 200, await res.text());

  const active = store.activeClaims("proj-1");
  assert.equal(active.length, 1);
  assert.equal(active[0].developerId, "alice@example.com", "server must ignore the client-supplied developerId");
});

test("POST /v1/claims: a developer who isn't a member of an already-founded project gets 403", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);
  // alice founds proj-1
  await app.request("/v1/claims", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", claims: [makeClaim({ projectId: "proj-1" })] }),
  });

  // bob, an unrelated developer with no invite to proj-1, joins a *different* org via his own bootstrap-less path --
  // simplest way to get a second real identity here is an org invite from alice, without a project invite.
  const inviteRes = await app.request("/v1/admin/invites", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ label: "bob@example.com", role: "member" }),
  });
  const invite = (await inviteRes.json()) as { code: string };
  const redeemRes = await app.request(`/v1/invites/${invite.code}/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tokenHash: sha256Hex("bobs-pat"), label: "bob@example.com" }),
  });
  assert.equal(redeemRes.status, 200, await redeemRes.text());

  const res = await app.request("/v1/claims", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer("bobs-pat") },
    body: JSON.stringify({ projectId: "proj-1", claims: [makeClaim({ projectId: "proj-1" })] }),
  });
  assert.equal(res.status, 403);
});

test("GET /v1/claims: returns active claims for a project, optionally filtered to one session", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  await app.request("/v1/claims", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({
      projectId: "proj-1",
      claims: [
        makeClaim({ projectId: "proj-1", sessionId: "sess-a", symbolId: "src/a.ts::f" }),
        makeClaim({ projectId: "proj-1", sessionId: "sess-b", symbolId: "src/b.ts::g" }),
      ],
    }),
  });

  const allRes = await app.request("/v1/claims?projectId=proj-1", { headers: bearer(admin.token) });
  assert.equal(allRes.status, 200);
  const allBody = (await allRes.json()) as { items: Claim[] };
  assert.equal(allBody.items.length, 2);
  // Server-stamped, not client-supplied (same invariant as POST /v1/claims).
  assert.ok(allBody.items.every((c) => c.developerId === admin.developerId));

  const scopedRes = await app.request("/v1/claims?projectId=proj-1&sessionId=sess-a", { headers: bearer(admin.token) });
  assert.equal(scopedRes.status, 200);
  const scopedBody = (await scopedRes.json()) as { items: Claim[] };
  assert.equal(scopedBody.items.length, 1);
  assert.equal(scopedBody.items[0].symbolId, "src/a.ts::f");
});

test("GET /v1/claims: requires ?projectId=, and 403s a non-member", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);
  await app.request("/v1/claims", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", claims: [makeClaim({ projectId: "proj-1" })] }),
  });

  const missingRes = await app.request("/v1/claims", { headers: bearer(admin.token) });
  assert.equal(missingRes.status, 400);

  const evesPat = await makeUnrelatedDeveloper(app, admin, "eve@example.com", "eves-pat");
  const forbiddenRes = await app.request("/v1/claims?projectId=proj-1", { headers: bearer(evesPat) });
  assert.equal(forbiddenRes.status, 403);
});

test("GET /v1/projects: lists every project the caller is a member of, merging in githubOwner/githubRepo/foundedBy/foundedAt", async () => {
  const { app, dataDir, identities } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  // proj-1: GitHub-founded, has a real owner/repo binding.
  identities.foundProject("proj-1", admin.developerId, { owner: "acme", repo: "widgets" });
  // proj-2: founded via the plain claims self-service path -- no GitHub binding.
  await app.request("/v1/claims", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-2", claims: [makeClaim({ projectId: "proj-2" })] }),
  });

  const res = await app.request("/v1/projects", { headers: bearer(admin.token) });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    items: { projectId: string; orgId: string; role: string; foundedBy?: string; foundedAt?: number; githubOwner?: string; githubRepo?: string }[];
  };
  assert.equal(body.items.length, 2);

  const proj1 = body.items.find((p) => p.projectId === "proj-1");
  assert.ok(proj1, "proj-1 must be listed");
  assert.equal(proj1!.role, "admin");
  assert.equal(proj1!.githubOwner, "acme");
  assert.equal(proj1!.githubRepo, "widgets");
  assert.equal(proj1!.foundedBy, admin.developerId);
  assert.equal(typeof proj1!.foundedAt, "number");

  const proj2 = body.items.find((p) => p.projectId === "proj-2");
  assert.ok(proj2, "proj-2 must be listed");
  assert.equal(proj2!.githubOwner, undefined, "proj-2 was never GitHub-bound");
  assert.equal(proj2!.foundedBy, admin.developerId);
});

test("GET /v1/projects: a developer who has founded nothing gets an empty list, not an error", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);
  const res = await app.request("/v1/projects", { headers: bearer(admin.token) });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { items: unknown[] };
  assert.deepEqual(body.items, []);
});

test("GET /v1/projects: unauthenticated is rejected with 401, same as every other /v1/* route", async () => {
  const { app } = freshApp();
  const res = await app.request("/v1/projects");
  assert.equal(res.status, 401);
});

test("CORS: an allowed origin's preflight gets Access-Control-Allow-Origin, and a real request isn't exempted from auth", async () => {
  const { app, dataDir } = freshApp({ corsOrigins: ["https://app.twing.dev"] });
  const admin = await bootstrapAdmin(app, dataDir);

  const preflight = await app.request("/v1/projects", {
    method: "OPTIONS",
    headers: { origin: "https://app.twing.dev", "access-control-request-method": "GET" },
  });
  assert.equal(preflight.headers.get("access-control-allow-origin"), "https://app.twing.dev");

  // CORS only controls whether a browser attaches the response -- it must
  // never bypass the real auth check for a same-origin-looking request
  // that still carries no bearer token.
  const noAuthRes = await app.request("/v1/projects", { headers: { origin: "https://app.twing.dev" } });
  assert.equal(noAuthRes.status, 401);

  const authedRes = await app.request("/v1/projects", { headers: { origin: "https://app.twing.dev", ...bearer(admin.token) } });
  assert.equal(authedRes.status, 200);
  assert.equal(authedRes.headers.get("access-control-allow-origin"), "https://app.twing.dev");
});

test("CORS: disabled (no corsOrigins configured) is the default -- no CORS headers, matching every existing self-hosted deployment", async () => {
  const { app } = freshApp();
  const preflight = await app.request("/v1/projects", {
    method: "OPTIONS",
    headers: { origin: "https://app.twing.dev", "access-control-request-method": "GET" },
  });
  assert.equal(preflight.headers.get("access-control-allow-origin"), null);
});

test("invite + keygen redemption: an admin never sees the invitee's plaintext token, only its hash crosses the wire", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  const inviteRes = await app.request("/v1/admin/invites", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ label: "bob@example.com", role: "member" }),
  });
  const invite = (await inviteRes.json()) as { code: string };

  const bobPlaintext = "bobs-real-secret-pat";
  const redeemRes = await app.request(`/v1/invites/${invite.code}/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tokenHash: sha256Hex(bobPlaintext), label: "bob@example.com" }),
  });
  assert.equal(redeemRes.status, 200);

  const whoami = await app.request("/v1/auth/whoami", { headers: bearer(bobPlaintext) });
  assert.equal(whoami.status, 200);
  const body = (await whoami.json()) as { developerId: string };
  assert.equal(body.developerId, "bob@example.com");
});

test("POST /v1/reviews/:id/decide: requires the project's admin role, not mere authentication", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  // alice founds proj-1 via a design registration, then bob creates a second, conflicting design and justifies the divergence.
  const check1 = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "first", creates: ["a.ts"], touches: [], dependsOn: [] }),
  });
  assert.equal(check1.status, 200);

  // A genuinely different developer registers the "second, overlapping"
  // design -- same-developer pairs no longer produce an overlap verdict at
  // all (2026-08-22). Must come after proj-1 is founded above, or the
  // invite this issues has no project to attach to yet.
  const otherPat = await addProjectMember(app, admin.token, "proj-1");

  const check2 = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(otherPat) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s2", summary: "second, overlapping", creates: ["a.ts"], touches: [], dependsOn: [] }),
  });
  assert.equal(check2.status, 200);
  const check2Body = (await check2.json()) as { verdict: string; designId: string };
  assert.equal(check2Body.verdict, "file_overlap");

  const resolveRes = await app.request(`/v1/designs/${check2Body.designId}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(otherPat) },
    body: JSON.stringify({ resolution: "justified_divergence", justification: "intentional, reviewed" }),
  });
  assert.equal(resolveRes.status, 200);
  const resolveBody = (await resolveRes.json()) as { reviewId: string };

  // Add carol as a plain *member* of proj-1 (not admin).
  const projInviteRes = await app.request("/v1/projects/proj-1/invites", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ label: "carol@example.com", role: "member" }),
  });
  const projInvite = (await projInviteRes.json()) as { code: string };
  await app.request(`/v1/invites/${projInvite.code}/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tokenHash: sha256Hex("carols-pat"), label: "carol@example.com" }),
  });

  const deniedRes = await app.request(`/v1/reviews/${resolveBody.reviewId}/decide`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer("carols-pat") },
    body: JSON.stringify({ decision: "approve" }),
  });
  assert.equal(deniedRes.status, 403, "a plain member must not be able to decide a review");

  const allowedRes = await app.request(`/v1/reviews/${resolveBody.reviewId}/decide`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ decision: "approve" }),
  });
  assert.equal(allowedRes.status, 200, await allowedRes.text());
});

/** Registers two overlapping designs for `projectId` and justifies the
 * second's divergence, landing exactly one pending review -- the shared
 * fixture for every GET /v1/reviews?status= test below. */
async function makePendingReview(app: ReturnType<typeof createApp>, token: string, projectId: string): Promise<string> {
  await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(token) },
    body: JSON.stringify({ projectId, sessionId: "s1", summary: "first", creates: ["a.ts"], touches: [], dependsOn: [] }),
  });

  // 2026-08-26 self-approve: a review with only a structural-overlap waiver
  // and no constraint hit auto-decides immediately on resolve (see
  // DesignVerdict's doc comment, core/types.ts -- constraint_violation is
  // the only bucket that still needs an admin). This helper is named/used
  // for the admin-review-queue surface (GET /v1/reviews, enrichment), which
  // needs the review to actually stay pending -- so seed a constraint that
  // also matches "a.ts", forcing the resolve below into the still-admin-
  // gated path, while still keeping the structural overlap so the enriched
  // review's conflicts array carries a real `kind: "overlap"` entry too.
  await app.request("/v1/constraints/seed", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(token) },
    body: JSON.stringify({ projectId, constraints: [{ statement: "a.ts needs sign-off", scope: ["a.ts"] }] }),
  });

  // A genuinely different developer registers the "overlapping" second
  // design -- same-developer pairs no longer produce an overlap verdict at
  // all (2026-08-22), so this helper needs two real identities to still
  // exercise the justify/review flow it's named for. Unique label/pat per
  // call: some callers invoke this twice against the same project.
  const suffix = crypto.randomUUID();
  const otherLabel = `reviewer-${suffix}@example.com`;
  const otherPat = `pat-${suffix}`;
  const inviteRes = await app.request(`/v1/projects/${projectId}/invites`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(token) },
    body: JSON.stringify({ label: otherLabel, role: "member" }),
  });
  const invite = (await inviteRes.json()) as { code: string };
  await app.request(`/v1/invites/${invite.code}/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tokenHash: sha256Hex(otherPat), label: otherLabel }),
  });

  const check2 = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(otherPat) },
    body: JSON.stringify({ projectId, sessionId: "s2", summary: "second, overlapping", creates: ["a.ts"], touches: [], dependsOn: [] }),
  });
  const { designId } = (await check2.json()) as { designId: string };
  const resolveRes = await app.request(`/v1/designs/${designId}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(otherPat) },
    body: JSON.stringify({ resolution: "justified_divergence", justification: "intentional, reviewed" }),
  });
  const { reviewId } = (await resolveRes.json()) as { reviewId: string };
  return reviewId;
}

test("GET /v1/reviews: defaults to ?status=pending, unchanged from before the query param existed", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);
  await makePendingReview(app, admin.token, "proj-1");

  const res = await app.request("/v1/reviews?projectId=proj-1", { headers: bearer(admin.token) });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { items: { id: string; decision?: string }[] };
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].decision, undefined);
});

// Enriched response (2026-08-25). Before this, the route returned review
// rows verbatim: the requester's justification plus opaque ids, and nothing
// about the work itself -- so twing-monitor's card led with the argument for
// letting something through without ever naming what it was. The unit tests
// in review-enrich.test.ts cover the assembly; this asserts the route
// actually wires it up, against a real design created through the real flow.
test("GET /v1/reviews: carries the design a review is about, not just its justification", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);
  await makePendingReview(app, admin.token, "proj-1");

  const res = await app.request("/v1/reviews?projectId=proj-1", { headers: bearer(admin.token) });
  const body = (await res.json()) as {
    items: {
      justification: string;
      design?: { summary: string; developerId: string; touches: string[]; status: string };
      conflicts?: { designId: string; kind: string; summary?: string }[];
    }[];
  };

  const item = body.items[0];
  // The original field is untouched -- this is a superset, so an older
  // dashboard reading this response still works exactly as before.
  assert.ok(item.justification.length > 0);

  assert.ok(item.design, "expected the review to carry its design");
  assert.ok(item.design.summary.length > 0, "expected a human-readable summary to lead with");
  assert.ok(item.design.developerId.length > 0, "expected to know who is asking");

  // makePendingReview justifies against a real overlap with a second
  // developer's design, so the reviewer should be able to see whose work it
  // collides with -- the question they're actually being asked.
  assert.ok(item.conflicts && item.conflicts.length > 0, "expected the conflicting design to be named");
  assert.equal(item.conflicts[0].kind, "overlap");
  assert.ok(item.conflicts[0].summary, "expected the conflicting design's summary to be resolved");
});

test("GET /v1/reviews?status=decided: only shows reviews an admin already decided", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);
  const reviewId = await makePendingReview(app, admin.token, "proj-1");

  const beforeDecide = await app.request("/v1/reviews?projectId=proj-1&status=decided", { headers: bearer(admin.token) });
  assert.deepEqual(((await beforeDecide.json()) as { items: unknown[] }).items, []);

  await app.request(`/v1/reviews/${reviewId}/decide`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ decision: "approve" }),
  });

  const afterDecide = await app.request("/v1/reviews?projectId=proj-1&status=decided", { headers: bearer(admin.token) });
  const body = (await afterDecide.json()) as { items: { id: string; decision?: string }[] };
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].decision, "approve");

  // The pending-status view must no longer show it now that it's decided.
  const stillPending = await app.request("/v1/reviews?projectId=proj-1&status=pending", { headers: bearer(admin.token) });
  assert.deepEqual(((await stillPending.json()) as { items: unknown[] }).items, []);
});

test("GET /v1/reviews?status=all: shows both pending and decided reviews together", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);
  await makePendingReview(app, admin.token, "proj-1");
  const reviewId2 = await makePendingReview(app, admin.token, "proj-1");
  await app.request(`/v1/reviews/${reviewId2}/decide`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ decision: "reject" }),
  });

  const res = await app.request("/v1/reviews?projectId=proj-1&status=all", { headers: bearer(admin.token) });
  const body = (await res.json()) as { items: unknown[] };
  assert.equal(body.items.length, 2);
});

test("GET /v1/reviews: an invalid ?status= is a 400, not a silent fallback", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);
  // Found proj-1 first (via claims self-service) so this 400 isn't masked
  // by a 403 for "not a member of a project that doesn't exist yet."
  await app.request("/v1/claims", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", claims: [makeClaim({ projectId: "proj-1" })] }),
  });
  const res = await app.request("/v1/reviews?projectId=proj-1&status=bogus", { headers: bearer(admin.token) });
  assert.equal(res.status, 400);
});

// Pagination (monitor UI load-time fix, 2026-08-29): GET /v1/reviews used to
// return every review matching the status filter, unbounded.
test("GET /v1/reviews: ?limit= paginates newest-first with a nextBefore cursor", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    ids.push(await makePendingReview(app, admin.token, "proj-1"));
    await new Promise((resolve) => setTimeout(resolve, 2)); // distinct createdAt per page boundary
  }
  ids.reverse();

  const page1Res = await app.request("/v1/reviews?projectId=proj-1&limit=2", { headers: bearer(admin.token) });
  const page1 = (await page1Res.json()) as { items: { id: string }[]; nextBefore?: number };
  assert.deepEqual(
    page1.items.map((r) => r.id),
    ids.slice(0, 2),
  );
  assert.ok(page1.nextBefore !== undefined);

  const page2Res = await app.request(`/v1/reviews?projectId=proj-1&limit=2&before=${page1.nextBefore}`, { headers: bearer(admin.token) });
  const page2 = (await page2Res.json()) as { items: { id: string }[]; nextBefore?: number };
  assert.deepEqual(
    page2.items.map((r) => r.id),
    ids.slice(2, 3),
  );
  assert.equal(page2.nextBefore, undefined, "last page carries no cursor");
});

test("GET /v1/reviews/:id: returns one enriched review by id, 404 for an unknown id or a project the caller isn't a member of", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);
  const reviewId = await makePendingReview(app, admin.token, "proj-1");

  const res = await app.request(`/v1/reviews/${reviewId}`, { headers: bearer(admin.token) });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { item: { id: string; design?: { summary: string } } };
  assert.equal(body.item.id, reviewId);
  assert.ok(body.item.design, "same enrichReviews treatment as the list route");

  const notFoundRes = await app.request(`/v1/reviews/no-such-id`, { headers: bearer(admin.token) });
  assert.equal(notFoundRes.status, 404);

  await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-other", sessionId: "s-other", summary: "", creates: ["z.ts"], touches: [], dependsOn: [] }),
  });
  const outsiderPat = await addProjectMember(app, admin.token, "proj-other");
  const outsiderRes = await app.request(`/v1/reviews/${reviewId}`, { headers: bearer(outsiderPat) });
  assert.equal(outsiderRes.status, 404);
});

test("GET /v1/reviews/:id: 404s for the unauthenticated public viewer, same as the list route", async () => {
  const { app, dataDir } = freshApp({ publicProjectIds: ["proj-1"] });
  const admin = await bootstrapAdmin(app, dataDir);
  const reviewId = await makePendingReview(app, admin.token, "proj-1");

  const res = await app.request(`/v1/reviews/${reviewId}`);
  assert.equal(res.status, 404);
});

test("GET /v1/activity: newest-first, respects ?limit=, ?before= pages backward, and ?kind= filters", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);
  // Each /v1/designs/check call appends *two* events (design_registered,
  // then design_checked -- app.ts logs both) -- 5 calls is 10 events total.
  // The ?kind= filter below is what isolates just the 5 design_registered
  // ones for a page/order assertion that doesn't depend on that detail.
  // The 1ms spacing guarantees distinct `ts` values -- eventsForProjectPage
  // has no secondary tiebreaker (a same-millisecond `before=` cursor could
  // otherwise drop a tied event at the page boundary), a known, accepted v1
  // gap real usage won't hit (real events are seconds/minutes apart, not
  // sub-millisecond synchronous bursts like this test's loop). Summaries
  // are deliberately unrelated topics, not "design 0"/"design 1"/... --
  // near-identical summary text trips the keyword-similarity overlap tier
  // (design-checks.ts) even across disjoint touched paths, which would add
  // design_flagged events this test isn't about.
  const summaries = [
    "design 0: retry helper with exponential backoff",
    "design 1: paginate the audit log endpoint",
    "design 2: rework the login screen's error copy",
    "design 3: add a health-check route",
    "design 4: migrate the constraint store to sqlite",
  ];
  for (let i = 0; i < 5; i++) {
    await app.request("/v1/designs/check", {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(admin.token) },
      body: JSON.stringify({ projectId: "proj-1", sessionId: `s${i}`, summary: summaries[i], creates: [`f${i}.ts`], touches: [], dependsOn: [], force: true }),
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
  }

  // Ground truth: all 5 design_registered events, unpaged.
  const all = await app.request("/v1/activity?projectId=proj-1&kind=design_registered", { headers: bearer(admin.token) });
  const allBody = (await all.json()) as { items: { id: string; ts: number; payload?: { summary?: string } }[] };
  assert.equal(allBody.items.length, 5);
  const allSummaries = new Set(allBody.items.map((e) => e.payload?.summary));
  assert.deepEqual(allSummaries, new Set(summaries));
  // Non-increasing ts -- newest-first. Registered in a tight loop, so ties
  // at millisecond resolution are expected and fine (no ordering guarantee
  // *within* a tie); only a genuine older-before-newer inversion is a bug.
  for (let i = 1; i < allBody.items.length; i++) {
    assert.ok(allBody.items[i - 1].ts >= allBody.items[i].ts, "newest-first");
  }

  const firstPage = await app.request("/v1/activity?projectId=proj-1&kind=design_registered&limit=3", { headers: bearer(admin.token) });
  assert.equal(firstPage.status, 200);
  const firstBody = (await firstPage.json()) as { items: { id: string }[]; nextBefore?: number };
  assert.equal(firstBody.items.length, 3);
  assert.ok(typeof firstBody.nextBefore === "number", "a fuller page than returned must carry a cursor");

  const secondPage = await app.request(`/v1/activity?projectId=proj-1&kind=design_registered&limit=3&before=${firstBody.nextBefore}`, {
    headers: bearer(admin.token),
  });
  const secondBody = (await secondPage.json()) as { items: { id: string }[]; nextBefore?: number };
  assert.equal(secondBody.items.length, 2, "only 2 design_registered events remain after the first page of 3 out of 5");
  assert.equal(secondBody.nextBefore, undefined, "the last page carries no further cursor");

  // The two pages together must reconstruct the full set exactly once each
  // -- no event lost or duplicated across the before= cursor boundary.
  const pagedIds = [...firstBody.items, ...secondBody.items].map((e) => e.id).sort();
  assert.deepEqual(pagedIds, allBody.items.map((e) => e.id).sort());

  // "Force a choice" registration-sprawl fix (2026-08-25): every call here
  // uses the same developer and disjoint touches/creates, so from the 2nd
  // call onward the broadened stale-sibling notice also fires once per
  // already-open, non-overlapping prior design -- 0+1+2+3+4 = 10 extra
  // design_stale_sibling_suggested events on top of the original 10
  // (design_registered + design_checked, one pair per check call).
  const unfiltered = await app.request("/v1/activity?projectId=proj-1", { headers: bearer(admin.token) });
  const unfilteredBody = (await unfiltered.json()) as { items: unknown[] };
  assert.equal(unfilteredBody.items.length, 20);

  const filteredOut = await app.request("/v1/activity?projectId=proj-1&kind=review_decided", { headers: bearer(admin.token) });
  assert.deepEqual(((await filteredOut.json()) as { items: unknown[] }).items, []);
});

test("GET /v1/activity: ?developerId= narrows to one developer's own events", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  // Found proj-1 as alice, then add bob as a real project member so his
  // events land in the same project's feed.
  await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "alice-sess", summary: "alice's design", creates: ["a.ts"], touches: [], dependsOn: [] }),
  });
  const inviteRes = await app.request("/v1/projects/proj-1/invites", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ label: "bob@example.com", role: "member" }),
  });
  const invite = (await inviteRes.json()) as { code: string };
  await app.request(`/v1/invites/${invite.code}/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tokenHash: sha256Hex("bobs-pat"), label: "bob@example.com" }),
  });
  await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer("bobs-pat") },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "bob-sess", summary: "bob's design", creates: ["b.ts"], touches: [], dependsOn: [] }),
  });

  const bobOnly = await app.request("/v1/activity?projectId=proj-1&developerId=bob@example.com&kind=design_registered", { headers: bearer(admin.token) });
  const bobBody = (await bobOnly.json()) as { items: { developerId?: string; payload?: { summary?: string } }[] };
  assert.equal(bobBody.items.length, 1);
  assert.equal(bobBody.items[0].developerId, "bob@example.com");
  assert.equal(bobBody.items[0].payload?.summary, "bob's design");

  const unfiltered = await app.request("/v1/activity?projectId=proj-1&kind=design_registered", { headers: bearer(admin.token) });
  const unfilteredBody = (await unfiltered.json()) as { items: unknown[] };
  assert.equal(unfilteredBody.items.length, 2, "no ?developerId= means both developers' events");
});

/** Redeems a brand-new, real identity that's authenticated to the server
 * but has no membership in `admin`'s projects at all -- an org invite
 * (not a project invite), same technique as the existing "a developer who
 * isn't a member of an already-founded project gets 403" claims test. */
async function makeUnrelatedDeveloper(app: ReturnType<typeof createApp>, admin: { token: string }, label: string, pat: string): Promise<string> {
  const inviteRes = await app.request("/v1/admin/invites", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ label, role: "member" }),
  });
  const invite = (await inviteRes.json()) as { code: string };
  await app.request(`/v1/invites/${invite.code}/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tokenHash: sha256Hex(pat), label }),
  });
  return pat;
}

/** Invites and redeems a second, real developer identity as a plain member
 * of `projectId` -- reusable wherever a test needs a genuinely different
 * developer to register the "other" side of an overlap/conflict test
 * fixture (same-developer pairs stopped producing overlap verdicts at all,
 * 2026-08-22 -- see design-checks.ts's top-of-file comment). Unique
 * label/pat per call, so repeated use within one test/project doesn't
 * collide.
 *
 * Founds `projectId` first (empty-constraints seed, same as `foundProject`
 * below) if it isn't already -- an invite needs an existing project to
 * attach to, and callers of this helper don't always already have one by
 * the time they need a second developer. A no-op, not a reset, when the
 * project is already founded: seeding `[]` adds nothing and removes
 * nothing. */
async function addProjectMember(app: ReturnType<typeof createApp>, adminToken: string, projectId: string): Promise<string> {
  await app.request("/v1/constraints/seed", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(adminToken) },
    body: JSON.stringify({ projectId, constraints: [] }),
  });

  const suffix = crypto.randomUUID();
  const label = `member-${suffix}@example.com`;
  const pat = `pat-${suffix}`;
  const inviteRes = await app.request(`/v1/projects/${projectId}/invites`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(adminToken) },
    body: JSON.stringify({ label, role: "member" }),
  });
  const invite = (await inviteRes.json()) as { code: string };
  await app.request(`/v1/invites/${invite.code}/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tokenHash: sha256Hex(pat), label }),
  });
  return pat;
}

test("GET /v1/activity: design_checked/design_flagged carry the full why (conflicts/constraint/summary), not just the bare verdict string", async () => {
  const { app, dataDir, designs } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  // Tier 1 (exact touches overlap) -- always advisory (file_overlap never
  // blocks, see DesignVerdict's doc comment, core/types.ts). Tier 4
  // (summary similarity) was removed entirely 2026-08-26 -- llm_divergence
  // (the semantic comparator) is its real replacement -- so tier 1 is now
  // the only source of an always-advisory, conflicts-populating verdict to
  // exercise here.
  const firstRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({
      projectId: "proj-1",
      sessionId: "s1",
      summary: "adds a shared caching layer for the payments service",
      creates: [],
      touches: ["payments.ts"],
      dependsOn: [],
    }),
  });
  const firstBody = (await firstRes.json()) as { verdict: string; designId: string };
  assert.equal(firstBody.verdict, "clean");

  // A genuinely different developer registers the "second" design -- same-
  // developer pairs no longer produce a file_overlap verdict at all
  // (2026-08-22). Must come after proj-1 is founded above.
  const otherPat = await addProjectMember(app, admin.token, "proj-1");

  const secondRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(otherPat) },
    body: JSON.stringify({
      projectId: "proj-1",
      sessionId: "s2",
      summary: "adds a shared caching layer for the billing service",
      creates: [],
      touches: ["payments.ts"], // exact overlap with the first design -- tier 1
      dependsOn: [],
    }),
  });
  const secondBody = (await secondRes.json()) as { verdict: string; designId: string };
  assert.equal(secondBody.verdict, "file_overlap", "tier 1 -- design_checked still logs conflicts on its own; design_flagged now only comes from the async semantic-conflict path (runSemanticComparatorPass)");

  // Simulate what runSemanticComparatorPass (app.ts) does on a real
  // llm_divergence hit -- flags the design directly, same DesignConflict
  // detail shape tier 1 already uses. Exercised this way rather than
  // through the real LLM call: this test is about design_flagged's
  // activity-log detail carrying through, not about the LLM's own
  // judgment.
  designs.flag(secondBody.designId, "llm_divergence", {
    conflicts: [
      {
        conflictingDesignId: firstBody.designId,
        overlapKind: "touches",
        overlapDetail: "these designs conflict in intent (simulated for this test)",
        conflictingSummary: "adds a shared caching layer for the payments service",
        overlapPaths: [],
      },
    ],
  });

  const activityRes = await app.request(`/v1/activity?projectId=proj-1&relatedId=${secondBody.designId}`, { headers: bearer(admin.token) });
  assert.equal(activityRes.status, 200);
  const activityBody = (await activityRes.json()) as { items: { kind: string; payload?: { verdict?: string; summary?: string; conflicts?: { conflictingSummary: string }[] } }[] };

  const checked = activityBody.items.find((e) => e.kind === "design_checked");
  assert.ok(checked, "?relatedId= must scope to just this design's own events");
  assert.equal(checked!.payload?.verdict, "file_overlap");
  assert.equal(checked!.payload?.summary, "adds a shared caching layer for the billing service");
  assert.equal(checked!.payload?.conflicts?.[0]?.conflictingSummary, "adds a shared caching layer for the payments service");

  const flagged = activityBody.items.find((e) => e.kind === "design_flagged");
  assert.ok(flagged, "the simulated llm_divergence flag must also log design_flagged");
  assert.equal(flagged!.payload?.summary, "adds a shared caching layer for the billing service");
  assert.equal(flagged!.payload?.conflicts?.[0]?.conflictingSummary, "adds a shared caching layer for the payments service");

  // Every returned event's relatedId really is this design -- not just an
  // artifact of it happening to be the only non-clean check in the test.
  const other = await app.request(`/v1/activity?projectId=proj-1&relatedId=proj-1-does-not-exist`, { headers: bearer(admin.token) });
  assert.deepEqual(((await other.json()) as { items: unknown[] }).items, []);
});

test("GET /v1/activity: requires project membership, same as every other project-scoped route", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);
  const evesPat = await makeUnrelatedDeveloper(app, admin, "eve@example.com", "eves-pat");
  const res = await app.request("/v1/activity?projectId=proj-1", { headers: bearer(evesPat) });
  assert.equal(res.status, 403);
});

test("GET /v1/constraints: lists every constraint seeded for a project", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);
  await app.request("/v1/constraints/seed", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({
      projectId: "proj-1",
      constraints: [{ statement: "don't invent a second wire format", scope: ["packages/core/src/framing.ts"], type: "constraint" }],
    }),
  });

  const res = await app.request("/v1/constraints?projectId=proj-1", { headers: bearer(admin.token) });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { items: { statement: string; type: string }[] };
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].statement, "don't invent a second wire format");
  assert.equal(body.items[0].type, "constraint");
});

test("GET /v1/constraints: empty for a project with nothing seeded, not an error", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);
  await app.request("/v1/claims", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", claims: [makeClaim({ projectId: "proj-1" })] }),
  });
  const res = await app.request("/v1/constraints?projectId=proj-1", { headers: bearer(admin.token) });
  assert.equal(res.status, 200);
  assert.deepEqual(((await res.json()) as { items: unknown[] }).items, []);
});

test("GET /v1/constraints: requires project membership", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);
  const evesPat = await makeUnrelatedDeveloper(app, admin, "eve@example.com", "eves-pat");
  const res = await app.request("/v1/constraints?projectId=proj-1", { headers: bearer(evesPat) });
  assert.equal(res.status, 403);
});

test("POST /v1/constraints/seed: founding a brand-new project stays open to a non-admin -- seeding is the founding trigger itself", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  // alice has never touched proj-new before -- this call must both found
  // the project (same as twing init's first-ever run against a repo the
  // server hasn't seen) and seed successfully, in one request.
  const res = await app.request("/v1/constraints/seed", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-new", constraints: [{ statement: "use pkg/retry", scope: ["src/**"] }] }),
  });
  const body = (await res.json()) as { seeded: number };
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.seeded, 1);
});

test("POST /v1/constraints/seed: an already-founded project's constraint change requires admin role (2026-08-16 fix)", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  // Found proj-1 first (as admin), matching a real project's history --
  // seeding on an *already-founded* project is what this test cares about.
  const foundRes = await app.request("/v1/constraints/seed", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", constraints: [{ statement: "use pkg/retry", scope: ["src/**"] }] }),
  });
  assert.equal(foundRes.status, 200);

  // Add carol as a plain *member* of proj-1 (not admin).
  const projInviteRes = await app.request("/v1/projects/proj-1/invites", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ label: "carol@example.com", role: "member" }),
  });
  const projInvite = (await projInviteRes.json()) as { code: string };
  await app.request(`/v1/invites/${projInvite.code}/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tokenHash: sha256Hex("carols-pat"), label: "carol@example.com" }),
  });

  const deniedRes = await app.request("/v1/constraints/seed", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer("carols-pat") },
    body: JSON.stringify({ projectId: "proj-1", constraints: [{ statement: "use pkg/retry", scope: ["**"] }] }),
  });
  assert.equal(deniedRes.status, 403, "a plain member must not be able to unilaterally change what's enforced");

  const allowedRes = await app.request("/v1/constraints/seed", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", constraints: [{ statement: "use pkg/retry", scope: ["**"] }] }),
  });
  assert.equal(allowedRes.status, 200, await allowedRes.text());
});

// --- DELETE /v1/constraints/:id -----------------------------------------------

/** proj-1 must actually be *founded* (a project membership row for the
 * admin, not just a bare constraint row the `constraints` fixture can
 * insert directly) before `canManageProject` has anything to say yes to --
 * seeding through the real route, same as the existing seed-admin-gating
 * test above, is what does that founding as a side effect. */
async function foundProject(app: ReturnType<typeof createApp>, adminToken: string, projectId = "proj-1"): Promise<void> {
  const res = await app.request("/v1/constraints/seed", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(adminToken) },
    body: JSON.stringify({ projectId, constraints: [] }),
  });
  assert.equal(res.status, 200, `founding ${projectId} via seed failed: ${await res.text()}`);
}

test("DELETE /v1/constraints/:id: an admin removes it unilaterally and immediately -- same shape seeding's add/update already has", async () => {
  const { app, dataDir, constraints } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);
  await foundProject(app, admin.token);
  const constraint = constraints.add("proj-1", "use pkg/retry", ["src/**"], "constraint", "seeded");

  const res = await app.request(`/v1/constraints/${constraint.id}`, { method: "DELETE", headers: bearer(admin.token) });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { removed: true });
  assert.deepEqual(constraints.forProject("proj-1"), []);
});

test("DELETE /v1/constraints/:id: a plain member is denied -- same admin-only bar as seeding", async () => {
  const { app, dataDir, constraints } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);
  await foundProject(app, admin.token);
  const constraint = constraints.add("proj-1", "use pkg/retry", ["src/**"], "constraint", "seeded");

  const projInviteRes = await app.request("/v1/projects/proj-1/invites", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ label: "carol@example.com", role: "member" }),
  });
  const projInvite = (await projInviteRes.json()) as { code: string };
  await app.request(`/v1/invites/${projInvite.code}/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tokenHash: sha256Hex("carols-pat"), label: "carol@example.com" }),
  });

  const res = await app.request(`/v1/constraints/${constraint.id}`, { method: "DELETE", headers: bearer("carols-pat") });
  assert.equal(res.status, 403);
  assert.equal(constraints.forProject("proj-1").length, 1, "member's denied attempt must not have deleted anything");
});

test("DELETE /v1/constraints/:id: 404 on an unknown id", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);
  await foundProject(app, admin.token);
  const res = await app.request("/v1/constraints/no-such-id", { method: "DELETE", headers: bearer(admin.token) });
  assert.equal(res.status, 404);
});

test("DELETE /v1/constraints/:id: authorization runs against the constraint's own projectId, not a caller-supplied one -- an admin of an unrelated project can't delete it", async () => {
  const { app, dataDir, constraints } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);
  await foundProject(app, admin.token);
  const constraint = constraints.add("proj-1", "use pkg/retry", ["src/**"], "constraint", "seeded");

  // dave is a real, authenticated developer -- just not a member of proj-1
  // at all (an org invite, not a project one -- see makeUnrelatedDeveloper's
  // own doc comment).
  const davesPat = await makeUnrelatedDeveloper(app, admin, "dave@example.com", "daves-pat");
  const res = await app.request(`/v1/constraints/${constraint.id}`, { method: "DELETE", headers: bearer(davesPat) });
  assert.equal(res.status, 403);
  assert.equal(constraints.forProject("proj-1").length, 1);
});

/** Sets up a project founded by alice, with an open design of hers on
 * `src/x.ts`, and bob added as a plain project member -- the shared
 * fixture for the alignment-thread tests below. */
async function fixtureWithOpenDesignAndSecondDeveloper(app: ReturnType<typeof createApp>, dataDir: string) {
  const admin = await bootstrapAdmin(app, dataDir); // alice
  const designRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s-alice", summary: "alice's work on x.ts", creates: [], touches: ["src/x.ts"], dependsOn: [] }),
  });
  assert.equal(designRes.status, 200, await designRes.text());

  const inviteRes = await app.request("/v1/projects/proj-1/invites", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ label: "bob@example.com", role: "member" }),
  });
  const invite = (await inviteRes.json()) as { code: string };
  const redeemRes = await app.request(`/v1/invites/${invite.code}/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tokenHash: sha256Hex("bobs-pat"), label: "bob@example.com" }),
  });
  assert.equal(redeemRes.status, 200, await redeemRes.text());

  return { alice: admin, bobToken: "bobs-pat" };
}

test("POST /v1/claims: a claim landing inside another session's open design produces a design_divergence finding with a threadId, visible via GET /v1/alignment-threads", async () => {
  const { app, dataDir } = freshApp();
  const { bobToken } = await fixtureWithOpenDesignAndSecondDeveloper(app, dataDir);

  const claimRes = await app.request("/v1/claims", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(bobToken) },
    body: JSON.stringify({ projectId: "proj-1", claims: [makeClaim({ projectId: "proj-1", sessionId: "s-bob", symbolId: "src/x.ts::f" })] }),
  });
  const claimBody = (await claimRes.json()) as { findings: { kind: string; threadId?: string; developerId: string; otherDeveloperId: string }[] };
  assert.equal(claimRes.status, 200, JSON.stringify(claimBody));
  const divergence = claimBody.findings.find((f) => f.kind === "design_divergence");
  assert.ok(divergence, "expected a design_divergence finding");
  assert.ok(divergence!.threadId, "expected a threadId on the finding");
  assert.equal(divergence!.developerId, "bob@example.com");
  assert.equal(divergence!.otherDeveloperId, "alice@example.com");

  const listRes = await app.request("/v1/alignment-threads?projectId=proj-1", { headers: bearer(bobToken) });
  const listBody = (await listRes.json()) as { items: { id: string }[] };
  assert.equal(listBody.items.length, 1);
  assert.equal(listBody.items[0].id, divergence!.threadId);
});

test("POST /v1/claims: resubmitting a changed claim against the same open divergence reuses the existing thread rather than opening a second one", async () => {
  const { app, dataDir } = freshApp();
  const { bobToken } = await fixtureWithOpenDesignAndSecondDeveloper(app, dataDir);

  const first = await app.request("/v1/claims", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(bobToken) },
    body: JSON.stringify({ projectId: "proj-1", claims: [makeClaim({ projectId: "proj-1", sessionId: "s-bob", symbolId: "src/x.ts::f", ts: 1000 })] }),
  });
  assert.equal(first.status, 200);

  // A later edit to the same symbol -- different ts, so Store.upsert treats
  // it as "changed" and the divergence check runs again.
  const second = await app.request("/v1/claims", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(bobToken) },
    body: JSON.stringify({ projectId: "proj-1", claims: [makeClaim({ projectId: "proj-1", sessionId: "s-bob", symbolId: "src/x.ts::f", ts: 2000 })] }),
  });
  assert.equal(second.status, 200);

  const listRes = await app.request("/v1/alignment-threads?projectId=proj-1", { headers: bearer(bobToken) });
  const listBody = (await listRes.json()) as { items: { id: string }[] };
  assert.equal(listBody.items.length, 1, "should reuse the same open thread, not open a second one");
});

test("POST /v1/claims: a divergence claim on a *different* symbol against the same design pair amends the thread instead of forking a new one (2026-08-23 dedup fix)", async () => {
  const { app, dataDir } = freshApp();
  const { bobToken } = await fixtureWithOpenDesignAndSecondDeveloper(app, dataDir);

  const first = await app.request("/v1/claims", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(bobToken) },
    body: JSON.stringify({ projectId: "proj-1", claims: [makeClaim({ projectId: "proj-1", sessionId: "s-bob", symbolId: "src/x.ts::f", ts: 1000 })] }),
  });
  const firstBody = (await first.json()) as { findings: { kind: string; threadId?: string }[] };
  const firstThreadId = firstBody.findings.find((f) => f.kind === "design_divergence")!.threadId!;

  const second = await app.request("/v1/claims", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(bobToken) },
    body: JSON.stringify({ projectId: "proj-1", claims: [makeClaim({ projectId: "proj-1", sessionId: "s-bob", symbolId: "src/x.ts::g", ts: 2000 })] }),
  });
  const secondBody = (await second.json()) as { findings: { kind: string; threadId?: string }[] };
  const secondThreadId = secondBody.findings.find((f) => f.kind === "design_divergence")!.threadId!;

  assert.equal(secondThreadId, firstThreadId, "same developer pair + target design -- must amend, not fork");

  const listRes = await app.request("/v1/alignment-threads?projectId=proj-1", { headers: bearer(bobToken) });
  const listBody = (await listRes.json()) as { items: { id: string; symbolIds: string[]; category: string; subKind: string; summary: string }[] };
  assert.equal(listBody.items.length, 1, "one thread, not two");
  assert.deepEqual(listBody.items[0].symbolIds.sort(), ["src/x.ts::f", "src/x.ts::g"]);
  assert.equal(listBody.items[0].category, "symbol_conflict");
  assert.equal(listBody.items[0].subKind, "scope_intrusion", "a design_divergence finding -- an edit landing inside another's declared scope");
  assert.match(listBody.items[0].summary, /declared scope/);
});

test("POST /v1/claims: a divergence finding links the claiming developer's own open design as initiatingDesignId, when they have one", async () => {
  const { app, dataDir } = freshApp();
  const { bobToken } = await fixtureWithOpenDesignAndSecondDeveloper(app, dataDir);

  const bobDesignRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(bobToken) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s-bob", summary: "bob's own work", creates: [], touches: ["src/y.ts"], dependsOn: [] }),
  });
  const bobDesignBody = (await bobDesignRes.json()) as { designId: string };

  const claimRes = await app.request("/v1/claims", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(bobToken) },
    body: JSON.stringify({ projectId: "proj-1", claims: [makeClaim({ projectId: "proj-1", sessionId: "s-bob", symbolId: "src/x.ts::f" })] }),
  });
  const { findings } = (await claimRes.json()) as { findings: { kind: string; threadId?: string }[] };
  const threadId = findings.find((f) => f.kind === "design_divergence")!.threadId!;

  const threadRes = await app.request(`/v1/alignment-threads/${threadId}`, { headers: bearer(bobToken) });
  const threadBody = (await threadRes.json()) as { thread: { initiatingDesignId?: string } };
  assert.equal(threadBody.thread.initiatingDesignId, bobDesignBody.designId);
});

test("POST /v1/claims: a divergence finding leaves initiatingDesignId unset when the claiming developer has no open design of their own", async () => {
  const { app, dataDir } = freshApp();
  const { bobToken } = await fixtureWithOpenDesignAndSecondDeveloper(app, dataDir);

  const claimRes = await app.request("/v1/claims", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(bobToken) },
    body: JSON.stringify({ projectId: "proj-1", claims: [makeClaim({ projectId: "proj-1", sessionId: "s-bob", symbolId: "src/x.ts::f" })] }),
  });
  const { findings } = (await claimRes.json()) as { findings: { kind: string; threadId?: string }[] };
  const threadId = findings.find((f) => f.kind === "design_divergence")!.threadId!;

  const threadRes = await app.request(`/v1/alignment-threads/${threadId}`, { headers: bearer(bobToken) });
  const threadBody = (await threadRes.json()) as { thread: { initiatingDesignId?: string } };
  assert.equal(threadBody.thread.initiatingDesignId, undefined, "no design behind the edit -- must stay honestly absent, not a wrong value");
});

test("alignment threads: only the two parties can read/reply/close -- a third project member gets 403", async () => {
  const { app, dataDir } = freshApp();
  const { alice, bobToken } = await fixtureWithOpenDesignAndSecondDeveloper(app, dataDir);

  const claimRes = await app.request("/v1/claims", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(bobToken) },
    body: JSON.stringify({ projectId: "proj-1", claims: [makeClaim({ projectId: "proj-1", sessionId: "s-bob", symbolId: "src/x.ts::f" })] }),
  });
  const { findings } = (await claimRes.json()) as { findings: { kind: string; threadId?: string }[] };
  const threadId = findings.find((f) => f.kind === "design_divergence")!.threadId!;

  // carol: a third project member, not a party to this thread.
  const carolInvite = await app.request("/v1/projects/proj-1/invites", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(alice.token) },
    body: JSON.stringify({ label: "carol@example.com", role: "member" }),
  });
  const carolCode = ((await carolInvite.json()) as { code: string }).code;
  await app.request(`/v1/invites/${carolCode}/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tokenHash: sha256Hex("carols-pat"), label: "carol@example.com" }),
  });

  const carolGet = await app.request(`/v1/alignment-threads/${threadId}`, { headers: bearer("carols-pat") });
  assert.equal(carolGet.status, 403);

  const carolPost = await app.request(`/v1/alignment-threads/${threadId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer("carols-pat") },
    body: JSON.stringify({ message: "let me in" }),
  });
  assert.equal(carolPost.status, 403);

  const carolClose = await app.request(`/v1/alignment-threads/${threadId}/close`, { method: "PATCH", headers: bearer("carols-pat") });
  assert.equal(carolClose.status, 403);

  // bob (a real party) can read, reply, and close.
  const bobGet = await app.request(`/v1/alignment-threads/${threadId}`, { headers: bearer(bobToken) });
  assert.equal(bobGet.status, 200);
  const bobPost = await app.request(`/v1/alignment-threads/${threadId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(bobToken) },
    body: JSON.stringify({ message: "ack, I'll rename mine" }),
  });
  assert.equal(bobPost.status, 200);
  const bobClose = await app.request(`/v1/alignment-threads/${threadId}/close`, { method: "PATCH", headers: bearer(bobToken) });
  assert.equal(bobClose.status, 200);
});

test("alignment threads: a project admin who isn't a party can list/read (but not reply/close) -- 2026-08-24 visibility reversal", async () => {
  const { app, dataDir } = freshApp();
  const { alice, bobToken } = await fixtureWithOpenDesignAndSecondDeveloper(app, dataDir);

  const claimRes = await app.request("/v1/claims", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(bobToken) },
    body: JSON.stringify({ projectId: "proj-1", claims: [makeClaim({ projectId: "proj-1", sessionId: "s-bob", symbolId: "src/x.ts::f" })] }),
  });
  const { findings } = (await claimRes.json()) as { findings: { kind: string; threadId?: string }[] };
  const threadId = findings.find((f) => f.kind === "design_divergence")!.threadId!;

  // dave: a second project *admin*, not a party to this thread -- found live
  // (2026-08-23): a project admin whose dashboard login identity differs
  // from the developerId their own claims/designs are authored under saw
  // zero alignment threads at all, since "party-only" had no admin
  // override. Read access now follows canManageProject; mutation stays
  // party-only.
  const daveInvite = await app.request("/v1/projects/proj-1/invites", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(alice.token) },
    body: JSON.stringify({ label: "dave-admin@example.com", role: "admin" }),
  });
  const daveCode = ((await daveInvite.json()) as { code: string }).code;
  await app.request(`/v1/invites/${daveCode}/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tokenHash: sha256Hex("daves-pat"), label: "dave-admin@example.com" }),
  });

  const daveList = await app.request("/v1/alignment-threads?projectId=proj-1", { headers: bearer("daves-pat") });
  assert.equal(daveList.status, 200);
  const daveListBody = (await daveList.json()) as { items: { id: string }[] };
  assert.ok(
    daveListBody.items.some((t) => t.id === threadId),
    "a non-party admin should see the thread in the project-wide list",
  );

  const daveGet = await app.request(`/v1/alignment-threads/${threadId}`, { headers: bearer("daves-pat") });
  assert.equal(daveGet.status, 200, "a non-party admin should be able to read the thread's detail/messages");

  const davePost = await app.request(`/v1/alignment-threads/${threadId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer("daves-pat") },
    body: JSON.stringify({ message: "trying to butt in" }),
  });
  assert.equal(davePost.status, 403, "admin visibility doesn't extend to acting inside a conversation they aren't named on");

  const daveClose = await app.request(`/v1/alignment-threads/${threadId}/close`, { method: "PATCH", headers: bearer("daves-pat") });
  assert.equal(daveClose.status, 403);
});

test("alignment threads: replying notifies the other party via the existing notice pipeline", async () => {
  const { app, dataDir } = freshApp();
  const { alice, bobToken } = await fixtureWithOpenDesignAndSecondDeveloper(app, dataDir);

  const claimRes = await app.request("/v1/claims", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(bobToken) },
    body: JSON.stringify({ projectId: "proj-1", claims: [makeClaim({ projectId: "proj-1", sessionId: "s-bob", symbolId: "src/x.ts::f" })] }),
  });
  const { findings } = (await claimRes.json()) as { findings: { kind: string; threadId?: string }[] };
  const threadId = findings.find((f) => f.kind === "design_divergence")!.threadId!;

  await app.request(`/v1/alignment-threads/${threadId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(bobToken) },
    body: JSON.stringify({ message: "ack, I'll rename mine" }),
  });

  const noticesRes = await app.request("/v1/notices?since=0", { headers: bearer(alice.token) });
  const noticesBody = (await noticesRes.json()) as { items: { message: string; threadId?: string }[] };
  const reply = noticesBody.items.find((n) => n.message.includes("ack, I'll rename mine"));
  assert.ok(reply, "alice should be notified of bob's reply");
  assert.equal(reply!.threadId, threadId);
});

test("POST /v1/designs/check: the async semantic-conflict comparator opens an alignment thread and notifies both developers, without delaying the response", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir); // alice

  const aliceDesign = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({
      projectId: "proj-1",
      sessionId: "s-alice",
      summary: "alice's retention sweep",
      creates: [],
      touches: ["src/activity-log.ts"],
      dependsOn: [],
    }),
  });
  assert.equal(aliceDesign.status, 200);

  const inviteRes = await app.request("/v1/projects/proj-1/invites", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ label: "bob@example.com", role: "member" }),
  });
  const invite = (await inviteRes.json()) as { code: string };
  await app.request(`/v1/invites/${invite.code}/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tokenHash: sha256Hex("bobs-pat"), label: "bob@example.com" }),
  });

  let bobDesignId: string | undefined;
  await withBedrockEnv(async () => {
    await withMockFetch(
      (async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ conflict: true, kind: "tension", reason: "they fight over the same guarantee" }) } }] }), {
          status: 200,
        })) as typeof fetch,
      async () => {
        const bobDesign = await app.request("/v1/designs/check", {
          method: "POST",
          headers: { "content-type": "application/json", ...bearer("bobs-pat") },
          body: JSON.stringify({
            projectId: "proj-1",
            sessionId: "s-bob",
            summary: "bob's audit permanence work",
            creates: [],
            touches: ["src/identity-store.ts"], // deliberately NOT the same file as alice's --
            // tier 1/2 stay clean, only the semantic comparator has anything to say here.
            dependsOn: [],
          }),
        });
        // The response itself must not wait on the comparator -- assert it
        // came back clean (no syntactic overlap) before asserting on the
        // fire-and-forget side effects below.
        const bobDesignBody = (await bobDesign.json()) as { verdict: string; designId: string };
        assert.equal(bobDesignBody.verdict, "clean");
        bobDesignId = bobDesignBody.designId;

        await waitFor(async () => {
          const res = await app.request("/v1/alignment-threads?projectId=proj-1", { headers: bearer("bobs-pat") });
          const body = (await res.json()) as { items: unknown[] };
          return body.items.length > 0;
        });
      },
    );
  });

  const threadsRes = await app.request("/v1/alignment-threads?projectId=proj-1", { headers: bearer(admin.token) });
  const threadsBody = (await threadsRes.json()) as {
    items: { developerId: string; otherDeveloperId: string; systemDescription: string; category: string; subKind: string; summary: string; initiatingDesignId?: string }[];
  };
  assert.equal(threadsBody.items.length, 1);
  assert.equal(threadsBody.items[0].developerId, "bob@example.com");
  assert.equal(threadsBody.items[0].otherDeveloperId, "alice@example.com");
  assert.equal(threadsBody.items[0].systemDescription, "they fight over the same guarantee");
  assert.equal(threadsBody.items[0].category, "llm_divergence", "the two self-approvable buckets' shared top-level name");
  assert.equal(threadsBody.items[0].subKind, "tension", "matches the comparator's own SemanticConflictKind");
  assert.match(threadsBody.items[0].summary, /Tension with/);
  assert.equal(threadsBody.items[0].initiatingDesignId, bobDesignId, "the candidate design (bob's) is always resolvable on this path");

  const aliceNotices = await app.request("/v1/notices?since=0", { headers: bearer(admin.token) });
  const aliceNoticesBody = (await aliceNotices.json()) as { items: { message: string }[] };
  assert.ok(aliceNoticesBody.items.some((n) => n.message === "they fight over the same guarantee"));

  const bobNotices = await app.request("/v1/notices?since=0", { headers: bearer("bobs-pat") });
  const bobNoticesBody = (await bobNotices.json()) as { items: { message: string }[] };
  assert.ok(bobNoticesBody.items.some((n) => n.message === "they fight over the same guarantee"));
});

// Found live (2026-08-26): runSemanticComparatorPass only ever checks the
// *current* design being registered/amended against everything else
// already open -- one-directional by construction. When bob's registration
// gets checked against alice's open design, then alice's own later amend
// gets checked against bob's, those used to land in two separate threads
// (developerId/otherDeveloperId reversed) for what's really one
// disagreement between one pair of designs -- confirmed live as two open
// threads for the same tension. alignment-store.ts's findOrCreate now
// recognizes the reverse direction and reuses the one thread instead --
// see alignment-store.test.ts's own dedicated reverse-match unit tests for
// that mechanism in isolation. This test used to also re-trigger the same
// pairing from alice's own side (via `amend`) to prove the two independent
// directions converge on one thread; since the both-sides llm_divergence
// blocking change (2026-08-27, tightening alignment threads item 1) that
// second trigger is no longer reachable through the HTTP API at all --
// alice's design is flagged by the very same pass that flags bob's, so her
// `amend` 409s instead of re-running the comparator, and even if it didn't,
// her `justifiedConflicts` (once she'd resolved) would suppress a repeat
// check against the same design anyway. What's left to verify here is
// simpler and, if anything, a stronger guarantee than before: one check
// from either side flags *both* designs into exactly one shared thread, in
// a single pass, with no window where a second thread could fork.
test("POST /v1/designs/check: an llm_divergence flags both designs into one shared thread from a single check", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir); // alice

  const aliceRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s-alice", summary: "alice's retention sweep", creates: [], touches: ["src/activity-log.ts"], dependsOn: [] }),
  });
  const { designId: aliceDesignId } = (await aliceRes.json()) as { designId: string };

  const inviteRes = await app.request("/v1/projects/proj-1/invites", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ label: "bob@example.com", role: "member" }),
  });
  const invite = (await inviteRes.json()) as { code: string };
  await app.request(`/v1/invites/${invite.code}/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tokenHash: sha256Hex("bobs-pat"), label: "bob@example.com" }),
  });

  let bobDesignId: string | undefined;
  await withBedrockEnv(async () => {
    await withMockFetch(
      (async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ conflict: true, kind: "tension", reason: "they fight over the same guarantee" }) } }] }), {
          status: 200,
        })) as typeof fetch,
      async () => {
        const bobRes = await app.request("/v1/designs/check", {
          method: "POST",
          headers: { "content-type": "application/json", ...bearer("bobs-pat") },
          body: JSON.stringify({ projectId: "proj-1", sessionId: "s-bob", summary: "bob's audit permanence work", creates: [], touches: ["src/identity-store.ts"], dependsOn: [] }),
        });
        bobDesignId = ((await bobRes.json()) as { designId: string }).designId;
        await waitFor(async () => {
          const res = await app.request("/v1/alignment-threads?projectId=proj-1", { headers: bearer(admin.token) });
          const body = (await res.json()) as { items: unknown[] };
          return body.items.length > 0;
        });
      },
    );
  });

  const threadsRes = await app.request("/v1/alignment-threads?projectId=proj-1", { headers: bearer(admin.token) });
  const threadsBody = (await threadsRes.json()) as { items: { id: string; initiatingDesignId?: string; designId?: string }[] };
  assert.equal(threadsBody.items.length, 1, "one check, one shared thread -- not one per side");
  assert.equal(threadsBody.items[0].initiatingDesignId, bobDesignId);
  assert.equal(threadsBody.items[0].designId, aliceDesignId);

  // Tightening alignment threads, item 1 (2026-08-27): llm_divergence used
  // to only ever flag the design that triggered the async comparator pass
  // -- symbol_conflict already blocked "both sides, whichever have an open
  // design," and leaving llm_divergence as initiator-only was an
  // unprincipled asymmetry under the four-bucket model's own "approval
  // belongs to whoever's authority you'd be overriding" rule (a real,
  // LLM-detected divergence is just as much the other side's problem). See
  // shouldFlagOtherSide (design-checks.ts) for the pure decision function
  // this exercises live.
  assert.ok(bobDesignId, "sanity: bob's design was registered");
  const flaggedRes = await app.request(`/v1/designs?projectId=proj-1&status=flagged`, { headers: bearer(admin.token) });
  const flaggedBody = (await flaggedRes.json()) as { items: { id: string; blockedReason?: string }[] };
  const flaggedIds = flaggedBody.items.map((d) => d.id);
  assert.ok(flaggedIds.includes(bobDesignId), "bob's own design (the initiator) is flagged");
  assert.ok(flaggedIds.includes(aliceDesignId), "alice's design (the other side) is flagged too -- both parties, not just the initiator");
  for (const d of flaggedBody.items) {
    assert.equal(d.blockedReason, "llm_divergence");
  }
});

// Found live (2026-08-26): resolving a design's block (self-approve or
// admin-decide, both end in DesignRegistry.decideReview) never touched the
// paired alignment thread at all -- a genuinely-resolved conflict and one
// nobody ever came back to looked identical from the thread's own point of
// view, both just sitting "open" forever with no trace of what happened.
test("POST /v1/designs/:id/resolve: self-approving an llm_divergence block posts a system note into its alignment thread", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir); // alice

  await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s-alice", summary: "alice's retention sweep", creates: [], touches: ["src/activity-log.ts"], dependsOn: [] }),
  });

  const inviteRes = await app.request("/v1/projects/proj-1/invites", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ label: "bob@example.com", role: "member" }),
  });
  const invite = (await inviteRes.json()) as { code: string };
  await app.request(`/v1/invites/${invite.code}/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tokenHash: sha256Hex("bobs-pat"), label: "bob@example.com" }),
  });

  let bobDesignId: string | undefined;
  let threadId: string | undefined;
  await withBedrockEnv(async () => {
    await withMockFetch(
      (async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ conflict: true, kind: "tension", reason: "they fight over the same guarantee" }) } }] }), {
          status: 200,
        })) as typeof fetch,
      async () => {
        const bobRes = await app.request("/v1/designs/check", {
          method: "POST",
          headers: { "content-type": "application/json", ...bearer("bobs-pat") },
          body: JSON.stringify({ projectId: "proj-1", sessionId: "s-bob", summary: "bob's audit permanence work", creates: [], touches: ["src/identity-store.ts"], dependsOn: [] }),
        });
        bobDesignId = ((await bobRes.json()) as { designId: string }).designId;
        await waitFor(async () => {
          const res = await app.request("/v1/alignment-threads?projectId=proj-1", { headers: bearer(admin.token) });
          const body = (await res.json()) as { items: { id: string }[] };
          if (body.items.length === 0) return false;
          threadId = body.items[0].id;
          return true;
        });
      },
    );
  });

  const resolveRes = await app.request(`/v1/designs/${bobDesignId}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer("bobs-pat") },
    body: JSON.stringify({ resolution: "justified_divergence", justification: "reviewed with alice offline, proceeding" }),
  });
  const resolveBody = (await resolveRes.json()) as { status: string };
  assert.equal(resolveBody.status, "resolved", "no constraint hits -- self-approves immediately");

  const threadRes = await app.request(`/v1/alignment-threads/${threadId}`, { headers: bearer(admin.token) });
  const threadBody = (await threadRes.json()) as { thread: { status: string }; messages: { message: string; authorId?: string }[] };
  // Only bob resolved -- both-sides llm_divergence blocking (2026-08-27,
  // tightening alignment threads item 1) means alice's design is *also*
  // flagged on this same pairing and she hasn't done anything about it yet,
  // so item 3's auto-close correctly leaves this open: settling one side is
  // not the same as settling the thread. See the "both sides independently
  // self-approving" test below for the case where it does close.
  assert.equal(threadBody.thread.status, "open", "only one side has resolved -- the thread must stay open until the other side settles too");
  const resolutionNote = threadBody.messages.find((m) => m.message.includes("Resolved"));
  assert.ok(resolutionNote, "the thread must show the block was actually cleared, not just look abandoned");
  assert.match(resolutionNote!.message, /bob@example\.com/);
  assert.match(resolutionNote!.message, /reviewed with alice offline, proceeding/);
  assert.equal(resolutionNote!.authorId, undefined, "a system note, not posted as either party");
});

// The reverse-direction merge (just above) means both sides' resolutions
// now land in the *same* thread -- this is what actually answers "who
// unblocked themselves and who didn't" from one place, rather than two
// disconnected threads each showing half the picture.
test("POST /v1/designs/:id/resolve: both sides independently self-approving a shared llm_divergence thread each post their own resolution note, then the thread auto-closes", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir); // alice

  const aliceRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s-alice", summary: "alice's retention sweep", creates: [], touches: ["src/activity-log.ts"], dependsOn: [] }),
  });
  const { designId: aliceDesignId } = (await aliceRes.json()) as { designId: string };

  const inviteRes = await app.request("/v1/projects/proj-1/invites", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ label: "bob@example.com", role: "member" }),
  });
  const invite = (await inviteRes.json()) as { code: string };
  await app.request(`/v1/invites/${invite.code}/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tokenHash: sha256Hex("bobs-pat"), label: "bob@example.com" }),
  });

  let bobDesignId: string | undefined;
  let threadId: string | undefined;
  await withBedrockEnv(async () => {
    await withMockFetch(
      (async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ conflict: true, kind: "tension", reason: "they fight over the same guarantee" }) } }] }), {
          status: 200,
        })) as typeof fetch,
      async () => {
        const bobRes = await app.request("/v1/designs/check", {
          method: "POST",
          headers: { "content-type": "application/json", ...bearer("bobs-pat") },
          body: JSON.stringify({ projectId: "proj-1", sessionId: "s-bob", summary: "bob's audit permanence work", creates: [], touches: ["src/identity-store.ts"], dependsOn: [] }),
        });
        bobDesignId = ((await bobRes.json()) as { designId: string }).designId;
        await waitFor(async () => {
          const res = await app.request("/v1/alignment-threads?projectId=proj-1", { headers: bearer(admin.token) });
          const body = (await res.json()) as { items: { id: string }[] };
          if (body.items.length === 0) return false;
          threadId = body.items[0].id;
          return true;
        });
      },
    );
  });

  // Bob resolves his side first.
  await app.request(`/v1/designs/${bobDesignId}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer("bobs-pat") },
    body: JSON.stringify({ resolution: "justified_divergence", justification: "bob's justification" }),
  });

  // Both-sides llm_divergence blocking (2026-08-27, tightening alignment
  // threads item 1) means alice's design was already flagged by the very
  // same comparator pass that flagged bob's -- there's no separate
  // re-trigger step needed (or, post this change, even possible: her
  // design is "flagged", not "open", so `amend` would 409) to get her into
  // the same shared thread. She can resolve hers directly.
  const aliceResolveRes = await app.request(`/v1/designs/${aliceDesignId}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ resolution: "justified_divergence", justification: "alice's justification" }),
  });
  assert.equal((await aliceResolveRes.json() as { status: string }).status, "resolved");

  const threadRes = await app.request(`/v1/alignment-threads/${threadId}`, { headers: bearer(admin.token) });
  const threadBody = (await threadRes.json()) as { thread: { status: string }; messages: { message: string }[] };
  const resolutionNotes = threadBody.messages.filter((m) => m.message.includes("Resolved"));
  assert.equal(resolutionNotes.length, 2, "both sides' resolutions must show up, in the one shared thread");
  assert.ok(resolutionNotes.some((m) => m.message.includes("bob@example.com") && m.message.includes("bob's justification")));
  assert.ok(resolutionNotes.some((m) => m.message.includes("alice@example.com") && m.message.includes("alice's justification")));

  // Item 3 (2026-08-27): now that *both* sides have settled, the thread
  // should auto-close -- the second resolve (alice's) is what tips it over.
  assert.equal(threadBody.thread.status, "closed", "both sides settled -- the thread should auto-close");
  assert.ok(
    threadBody.messages.some((m) => m.message.includes("Auto-closed")),
    "the auto-close should leave its own visible trail, same as a resolution note does",
  );
});

test("POST /v1/designs/:id/resolve: self-approving a symbol_conflict block posts a system note into the shared thread, for either side, then the thread auto-closes", async () => {
  const { app, dataDir } = freshApp();
  const { alice, bobToken } = await fixtureWithOpenDesignAndSecondDeveloper(app, dataDir); // alice's design already covers src/x.ts

  const bobDesignRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(bobToken) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s-bob", summary: "bob's own work", creates: [], touches: ["src/y.ts"], dependsOn: [] }),
  });
  const { designId: bobDesignId } = (await bobDesignRes.json()) as { designId: string };

  const claimRes = await app.request("/v1/claims", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(bobToken) },
    body: JSON.stringify({ projectId: "proj-1", claims: [makeClaim({ projectId: "proj-1", sessionId: "s-bob", symbolId: "src/x.ts::f" })] }),
  });
  const { findings } = (await claimRes.json()) as { findings: { kind: string; threadId?: string }[] };
  const threadId = findings.find((f) => f.kind === "design_divergence")!.threadId!;

  // Get alice's design id (the one intruded upon) from the thread itself.
  const beforeRes = await app.request(`/v1/alignment-threads/${threadId}`, { headers: bearer(alice.token) });
  const aliceDesignId = ((await beforeRes.json()) as { thread: { designId?: string } }).thread.designId!;

  // Bob (the intruder) resolves his own side first.
  const bobResolveRes = await app.request(`/v1/designs/${bobDesignId}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(bobToken) },
    body: JSON.stringify({ resolution: "justified_divergence", justification: "bob's justification" }),
  });
  assert.equal((await bobResolveRes.json() as { status: string }).status, "resolved");

  // Alice (the intruded-upon party) independently resolves hers too.
  const aliceResolveRes = await app.request(`/v1/designs/${aliceDesignId}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(alice.token) },
    body: JSON.stringify({ resolution: "justified_divergence", justification: "alice's justification" }),
  });
  assert.equal((await aliceResolveRes.json() as { status: string }).status, "resolved");

  const afterRes = await app.request(`/v1/alignment-threads/${threadId}`, { headers: bearer(alice.token) });
  const afterBody = (await afterRes.json()) as { thread: { status: string }; messages: { message: string }[] };
  const resolutionNotes = afterBody.messages.filter((m) => m.message.includes("Resolved"));
  assert.equal(resolutionNotes.length, 2, "both the initiator and the referenced side must each show up as resolved");
  assert.ok(resolutionNotes.some((m) => m.message.includes("bob@example.com") && m.message.includes("bob's justification")));
  assert.ok(resolutionNotes.some((m) => m.message.includes("alice@example.com") && m.message.includes("alice's justification")));

  // Item 3 (2026-08-27): same auto-close guarantee as the llm_divergence
  // case above, exercised here for symbol_conflict instead.
  assert.equal(afterBody.thread.status, "closed", "both sides settled -- the thread should auto-close");
  assert.ok(
    afterBody.messages.some((m) => m.message.includes("Auto-closed")),
    "the auto-close should leave its own visible trail, same as a resolution note does",
  );
});

// Reopen-on-new-finding fix (2026-08-28): continues exactly the scenario
// above (a symbol_conflict thread that both sides settled and that
// auto-closed) one step further -- a decideReview approve unconditionally
// reopens the *design* itself back to "open" (design-store.ts), so both
// alice's and bob's designs are live again after that resolution, same ids
// as before. A genuinely new collision between the same pair must reuse
// (and reopen) that same closed thread, not silently fork a new one --
// findOrCreate's dedup key is still the same design pair.
test("POST /v1/claims: a new symbol_conflict finding against the same design pair reopens an already-closed thread instead of forking a new one, since both designs are live again", async () => {
  const { app, dataDir } = freshApp();
  const { alice, bobToken } = await fixtureWithOpenDesignAndSecondDeveloper(app, dataDir); // alice's design already covers src/x.ts

  const bobDesignRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(bobToken) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s-bob", summary: "bob's own work", creates: [], touches: ["src/y.ts"], dependsOn: [] }),
  });
  const { designId: bobDesignId } = (await bobDesignRes.json()) as { designId: string };

  const firstClaimRes = await app.request("/v1/claims", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(bobToken) },
    body: JSON.stringify({ projectId: "proj-1", claims: [makeClaim({ projectId: "proj-1", sessionId: "s-bob", symbolId: "src/x.ts::f" })] }),
  });
  const { findings: firstFindings } = (await firstClaimRes.json()) as { findings: { kind: string; threadId?: string }[] };
  const threadId = firstFindings.find((f) => f.kind === "design_divergence")!.threadId!;

  const beforeRes = await app.request(`/v1/alignment-threads/${threadId}`, { headers: bearer(alice.token) });
  const aliceDesignId = ((await beforeRes.json()) as { thread: { designId?: string } }).thread.designId!;

  // Both sides resolve, exactly as the auto-close test above -- the thread
  // closes, and both designs flip back to "open" (decideReview's approve
  // path is unconditional about this, same ids as before).
  await app.request(`/v1/designs/${bobDesignId}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(bobToken) },
    body: JSON.stringify({ resolution: "justified_divergence", justification: "bob's justification" }),
  });
  await app.request(`/v1/designs/${aliceDesignId}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(alice.token) },
    body: JSON.stringify({ resolution: "justified_divergence", justification: "alice's justification" }),
  });
  const midRes = await app.request(`/v1/alignment-threads/${threadId}`, { headers: bearer(alice.token) });
  assert.equal(((await midRes.json()) as { thread: { status: string } }).thread.status, "closed", "sanity check: same as the test above");

  // A genuinely new collision -- a different symbol, still inside alice's
  // declared scope, still outside bob's -- between the same still-live pair.
  const secondClaimRes = await app.request("/v1/claims", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(bobToken) },
    body: JSON.stringify({ projectId: "proj-1", claims: [makeClaim({ projectId: "proj-1", sessionId: "s-bob", symbolId: "src/x.ts::g", ts: 2000 })] }),
  });
  const { findings: secondFindings } = (await secondClaimRes.json()) as { findings: { kind: string; threadId?: string }[] };
  const secondThreadId = secondFindings.find((f) => f.kind === "design_divergence")!.threadId!;
  assert.equal(secondThreadId, threadId, "must reuse the existing thread, not fork a new one, for the same design pair");

  const listRes = await app.request("/v1/alignment-threads?projectId=proj-1", { headers: bearer(alice.token) });
  assert.equal(((await listRes.json()) as { items: unknown[] }).items.length, 1, "still exactly one thread for this pair");

  const afterRes = await app.request(`/v1/alignment-threads/${threadId}`, { headers: bearer(alice.token) });
  const afterBody2 = (await afterRes.json()) as { thread: { status: string }; messages: { message: string }[] };
  assert.equal(afterBody2.thread.status, "open", "both designs are live again -- the new finding reopens the conversation");
  assert.ok(
    afterBody2.messages.some((m) => m.message.includes("src/x.ts::g")),
    `expected the new finding's own message in the reopened thread's history: ${JSON.stringify(afterBody2.messages)}`,
  );

  // And both designs are genuinely re-blocked -- the reopened thread isn't
  // just a stale label, the underlying enforcement actually re-armed too.
  const aliceListRes = await app.request(`/v1/designs?projectId=proj-1&sessionId=s-alice`, { headers: bearer(alice.token) });
  const aliceDesigns = (await aliceListRes.json()) as { items: { id: string; status: string }[] };
  assert.equal(aliceDesigns.items.find((d) => d.id === aliceDesignId)?.status, "flagged");
});

// The negative case: nobody's left to act on it, so the thread must stay
// closed even though the finding is still recorded.
// Uses `textual_overlap` (two developers writing the same symbol) rather
// than `design_divergence` -- that check fires whether or not either side
// has a design at all (design-divergence.ts's own check is gated on the
// intruded-upon design still being open, so it can't reach a state where a
// finding lands with the referenced design already closed; `textualOverlap`,
// checks.ts, has no such gate). Neither alice nor bob ever registers a
// design here, which is the simplest way to get `reopenEligible: false` on
// both sides of every finding.
test("POST /v1/claims: a new textual_overlap finding against a pair whose thread already closed leaves it closed when neither side has a live design", async () => {
  const { app, dataDir, alignmentThreads } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir); // alice
  const bobToken = await addProjectMember(app, admin.token, "proj-1");

  await app.request("/v1/claims", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", claims: [makeClaim({ projectId: "proj-1", sessionId: "s-alice", symbolId: "src/shared.ts::f" })] }),
  });
  const firstRes = await app.request("/v1/claims", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(bobToken) },
    body: JSON.stringify({ projectId: "proj-1", claims: [makeClaim({ projectId: "proj-1", sessionId: "s-bob", symbolId: "src/shared.ts::f" })] }),
  });
  const { findings } = (await firstRes.json()) as { findings: { kind: string; threadId?: string }[] };
  const threadId = findings.find((f) => f.kind === "textual_overlap")!.threadId!;

  alignmentThreads.close(threadId, "alice@example.com");

  // A genuinely new overlap between the same pair, still neither side ever
  // having registered a design.
  await app.request("/v1/claims", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", claims: [makeClaim({ projectId: "proj-1", sessionId: "s-alice", symbolId: "src/shared.ts::g" })] }),
  });
  const secondRes = await app.request("/v1/claims", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(bobToken) },
    body: JSON.stringify({ projectId: "proj-1", claims: [makeClaim({ projectId: "proj-1", sessionId: "s-bob", symbolId: "src/shared.ts::g" })] }),
  });
  const { findings: secondFindings } = (await secondRes.json()) as { findings: { kind: string; threadId?: string }[] };
  assert.equal(secondFindings.find((f) => f.kind === "textual_overlap")!.threadId, threadId, "still reuses the existing thread, not a fork");

  const afterRes = await app.request(`/v1/alignment-threads/${threadId}`, { headers: bearer(admin.token) });
  const afterBody = (await afterRes.json()) as { thread: { status: string }; messages: { message: string }[] };
  assert.equal(afterBody.thread.status, "closed", "neither side ever had a live design -- nobody to act on it, so it stays closed");
  assert.ok(
    afterBody.messages.some((m) => m.message.includes("src/shared.ts::g")),
    "the finding is still recorded even though the thread doesn't reopen",
  );
});

// Item 3's other fix, found while scoping the auto-close work: a bundled
// review (constraintIds *and* conflictWaivers together -- reachable
// whenever a design has both an active constraint match and an open
// llm_divergence thread at justify time) that an admin *rejects* used to
// post "Resolved: alice's design was rejectd -- ..." into the paired
// thread -- wrong grammar, and wrong semantics (a reject means the design
// closes, it isn't a resolution; only approve ever appends to
// justifiedConflicts). The alignment thread itself is built directly via
// the store (not the real Bedrock-mocked comparator pass) since this test
// is about the decide-path note text and auto-close eligibility, not the
// LLM's own judgment -- same "simulate what the async pass does" pattern
// `designs.flag()` gets used for elsewhere in this file.
test("POST /v1/reviews/:id/decide: rejecting a bundled constraint+llm_divergence review closes the design and posts an accurate (not 'Resolved') note, without auto-closing the thread on its own", async () => {
  const { app, dataDir, constraints, alignmentThreads } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir); // alice
  const constraint = constraints.add("proj-1", "money paths need a second pair of eyes", ["shared.ts"], "constraint", "seeded");

  const aliceRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s-alice", summary: "alice's work", creates: [], touches: ["shared.ts"], dependsOn: [] }),
  });
  const { designId: aliceDesignId, verdict } = (await aliceRes.json()) as { designId: string; verdict: string };
  assert.equal(verdict, "constraint_violation", "sanity: registration itself must already see the constraint hit");

  const otherPat = await addProjectMember(app, admin.token, "proj-1");
  const bobRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(otherPat) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s-bob", summary: "bob's unrelated work", creates: [], touches: ["other.ts"], dependsOn: [] }),
  });
  const { designId: bobDesignId } = (await bobRes.json()) as { designId: string };

  const thread = alignmentThreads.findOrCreate({
    projectId: "proj-1",
    symbolIds: [],
    developerId: admin.developerId,
    otherDeveloperId: "bob@example.com",
    designId: bobDesignId,
    systemDescription: "they fight over the same guarantee",
    category: "llm_divergence",
    subKind: "tension",
    summary: "alice's work vs bob's unrelated work",
    initiatingDesignId: aliceDesignId,
    ts: Date.now(),
    reopenEligible: false,
  });

  const resolveRes = await app.request(`/v1/designs/${aliceDesignId}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ resolution: "justified_divergence", justification: "reviewed, proceeding anyway" }),
  });
  const resolveBody = (await resolveRes.json()) as { status: string; reviewId: string };
  assert.equal(resolveBody.status, "pending_review", "a constraint hit in the mix means this can't self-approve, even bundled with the divergence waiver");

  const pendingRes = await app.request(`/v1/reviews?projectId=proj-1&status=pending`, { headers: bearer(admin.token) });
  const pendingBody = (await pendingRes.json()) as { items: { id: string; constraintIds: string[]; conflictWaivers?: { conflictingDesignId: string }[] }[] };
  const review = pendingBody.items.find((r) => r.id === resolveBody.reviewId)!;
  assert.deepEqual(review.constraintIds, [constraint.id]);
  assert.deepEqual(review.conflictWaivers, [{ conflictingDesignId: bobDesignId }], "the bundled divergence waiver must be captured too, not dropped for having a constraint alongside it");

  await app.request(`/v1/reviews/${resolveBody.reviewId}/decide`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ decision: "reject" }),
  });

  const designRes = await app.request(`/v1/designs?projectId=proj-1&sessionId=s-alice`, { headers: bearer(admin.token) });
  const designBody = (await designRes.json()) as { items: { id: string; status: string; justifiedConflicts: string[] }[] };
  const aliceDesign = designBody.items.find((d) => d.id === aliceDesignId)!;
  assert.equal(aliceDesign.status, "closed", "a rejected review is terminal -- the design closes rather than staying flagged");
  assert.deepEqual(aliceDesign.justifiedConflicts, [], "a reject must never populate justifiedConflicts -- only approve does");

  const threadRes = await app.request(`/v1/alignment-threads/${thread.id}`, { headers: bearer(admin.token) });
  const threadBody = (await threadRes.json()) as { thread: { status: string }; messages: { message: string }[] };
  const note = threadBody.messages.find((m) => m.message.includes("rejected"));
  assert.ok(note, "the thread must show what happened to this side, even on a reject");
  assert.ok(!note!.message.startsWith("Resolved:"), `a reject is not a resolution -- must not be labeled "Resolved:", got ${JSON.stringify(note!.message)}`);
  assert.ok(!note!.message.includes("rejectd"), `must not contain the old grammar bug, got ${JSON.stringify(note!.message)}`);
  assert.match(note!.message, /rejected and closed/);

  // Bob's side was never touched at all -- still genuinely open, not
  // settled -- so even though alice's side is now "closed" (via the reject,
  // not a resolution), the thread must not auto-close on her side alone.
  assert.equal(threadBody.thread.status, "open", "the other side hasn't settled -- a reject-driven close on one side is not enough by itself");
});

// Item 3's other call site (2026-08-27): the design close route
// (`PATCH /v1/designs/:id/close`), not just decide -- item 2's new
// "close it if that work is done" deny option is exactly the case this
// covers: bob doesn't resolve his side at all, he just closes the design
// outright, which must count as settling his half just as much as an
// approved justification would.
test("PATCH /v1/designs/:id/close: closing a design instead of resolving it also settles its side of a shared llm_divergence thread, auto-closing once alice's side is already resolved", async () => {
  const { app, dataDir, designs, alignmentThreads } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir); // alice

  const aliceRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s-alice", summary: "alice's work", creates: [], touches: ["a.ts"], dependsOn: [] }),
  });
  const { designId: aliceDesignId } = (await aliceRes.json()) as { designId: string };

  const otherPat = await addProjectMember(app, admin.token, "proj-1");
  const bobRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(otherPat) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s-bob", summary: "bob's work", creates: [], touches: ["b.ts"], dependsOn: [] }),
  });
  const { designId: bobDesignId } = (await bobRes.json()) as { designId: string };

  const thread = alignmentThreads.findOrCreate({
    projectId: "proj-1",
    symbolIds: [],
    developerId: admin.developerId,
    otherDeveloperId: "bob@example.com",
    designId: bobDesignId,
    systemDescription: "they fight over the same guarantee",
    category: "llm_divergence",
    subKind: "tension",
    summary: "alice's work vs bob's work",
    initiatingDesignId: aliceDesignId,
    ts: Date.now(),
    reopenEligible: false,
  });
  designs.flag(aliceDesignId, "llm_divergence", { conflicts: [{ conflictingDesignId: bobDesignId, overlapKind: "touches", overlapDetail: "tension", conflictingSummary: "bob's work", overlapPaths: [] }] });
  designs.flag(bobDesignId, "llm_divergence", { conflicts: [{ conflictingDesignId: aliceDesignId, overlapKind: "touches", overlapDetail: "tension", conflictingSummary: "alice's work", overlapPaths: [] }] });

  // Alice resolves her side normally.
  const resolveRes = await app.request(`/v1/designs/${aliceDesignId}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ resolution: "justified_divergence", justification: "reviewed, proceeding" }),
  });
  assert.equal((await resolveRes.json() as { status: string }).status, "resolved");

  const beforeRes = await app.request(`/v1/alignment-threads/${thread.id}`, { headers: bearer(admin.token) });
  assert.equal(((await beforeRes.json()) as { thread: { status: string } }).thread.status, "open", "sanity: only one side settled so far");

  // Bob closes instead of resolving.
  const closeRes = await app.request(`/v1/designs/${bobDesignId}/close`, { method: "PATCH", headers: bearer(otherPat) });
  assert.equal((await closeRes.json() as { status: string }).status, "closed");

  const afterRes = await app.request(`/v1/alignment-threads/${thread.id}`, { headers: bearer(admin.token) });
  const afterBody = (await afterRes.json()) as { thread: { status: string }; messages: { message: string }[] };
  assert.equal(afterBody.thread.status, "closed", "both sides now settled (one resolved, one closed) -- the thread should auto-close");
  assert.ok(afterBody.messages.some((m) => m.message.includes("Auto-closed")));
});

test("POST /v1/designs/check: the async semantic-conflict comparator produces no side effects when it finds nothing", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s-alice", summary: "alice's work", creates: [], touches: ["a.ts"], dependsOn: [] }),
  });

  await withBedrockEnv(() =>
    withMockFetch(
      (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ conflict: false, kind: null, reason: "unrelated" }) } }] }), { status: 200 })) as typeof fetch,
      async () => {
        await app.request("/v1/designs/check", {
          method: "POST",
          headers: { "content-type": "application/json", ...bearer(admin.token) },
          body: JSON.stringify({ projectId: "proj-1", sessionId: "s-alice-2", summary: "alice's second, unrelated design", creates: [], touches: ["b.ts"], dependsOn: [] }),
        });
        // No predicate to poll for absence, so give the (mocked, fast)
        // background task a real chance to run before asserting nothing
        // showed up.
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
    ),
  );

  const threadsRes = await app.request("/v1/alignment-threads?projectId=proj-1", { headers: bearer(admin.token) });
  const threadsBody = (await threadsRes.json()) as { items: unknown[] };
  assert.equal(threadsBody.items.length, 0);
});

// Pagination (monitor UI load-time fix, 2026-08-29): GET /v1/alignment-threads
// used to return every thread ever opened for a project, unbounded -- seeds
// threads directly via the store (findOrCreate, not the full claims/design
// pipeline -- that's already covered by every test above) purely to
// exercise the new ?before=/?limit= route wiring.
test("GET /v1/alignment-threads: ?limit= paginates newest-first with a nextBefore cursor", async () => {
  const { app, dataDir, alignmentThreads } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);
  // proj-1 needs to actually be founded (admin a real member of it) before
  // GET /v1/alignment-threads?projectId=proj-1 will pass isProjectMember --
  // seeding threads directly via the store below bypasses the founding
  // that a real /v1/designs/check or /v1/claims call would otherwise do.
  await app.request("/v1/claims", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", claims: [] }),
  });
  // admin is the `developerId` party on every seeded thread, so
  // canViewThread accepts them without any extra setup.
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    const t = alignmentThreads.findOrCreate({
      projectId: "proj-1",
      symbolIds: [`src/f${i}.ts`],
      developerId: admin.developerId,
      otherDeveloperId: "bob@example.com",
      designId: `d${i}`,
      systemDescription: `divergence ${i}`,
      category: "symbol_conflict",
      subKind: "scope_intrusion",
      summary: `overlap ${i}`,
      reopenEligible: false,
    });
    ids.push(t.id);
    await new Promise((resolve) => setTimeout(resolve, 2)); // distinct lastActivityAt per page boundary
  }
  ids.reverse();

  const page1Res = await app.request("/v1/alignment-threads?projectId=proj-1&limit=2", { headers: bearer(admin.token) });
  const page1 = (await page1Res.json()) as { items: { id: string }[]; nextBefore?: number };
  assert.deepEqual(
    page1.items.map((t) => t.id),
    ids.slice(0, 2),
  );
  assert.ok(page1.nextBefore !== undefined);

  const page2Res = await app.request(`/v1/alignment-threads?projectId=proj-1&limit=2&before=${page1.nextBefore}`, { headers: bearer(admin.token) });
  const page2 = (await page2Res.json()) as { items: { id: string }[]; nextBefore?: number };
  assert.deepEqual(
    page2.items.map((t) => t.id),
    ids.slice(2, 4),
  );

  const page3Res = await app.request(`/v1/alignment-threads?projectId=proj-1&limit=2&before=${page2.nextBefore}`, { headers: bearer(admin.token) });
  const page3 = (await page3Res.json()) as { items: { id: string }[]; nextBefore?: number };
  assert.deepEqual(
    page3.items.map((t) => t.id),
    ids.slice(4, 5),
  );
  assert.equal(page3.nextBefore, undefined, "last page carries no cursor");
});

// --- §17 scope enforcement (2026-08): flag / scope-match / amend ---

test("designs.flag(..., 'llm_divergence', ...) persists as status 'flagged', not 'open' (§17 scope enforcement, async semantic-conflict path)", async () => {
  const { app, dataDir, designs } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  // Since 2026-08-26 the only synchronous verdicts /v1/designs/check can
  // return are "clean", "file_overlap" (always advisory, tier 1), and
  // "constraint_violation" (always blocks, tier 3) -- see DesignVerdict's
  // doc comment, core/types.ts. The design-vs-design conflict path that
  // actually flags with "llm_divergence" is the async semantic comparator
  // (runSemanticComparatorPass, app.ts), which calls designs.flag(id,
  // "llm_divergence", ...) directly once its LLM check returns -- exercised
  // here the same way, since this test is about status persistence, not
  // the LLM's own judgment (see design-eval.test.ts for that).
  const registerRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s2", summary: "adds retry logic for the billing client", creates: ["b.ts"], touches: [], dependsOn: [] }),
  });
  const { designId } = (await registerRes.json()) as { designId: string };

  designs.flag(designId, "llm_divergence", {
    conflicts: [
      {
        conflictingDesignId: "other-design-id",
        overlapKind: "touches",
        overlapDetail: "these designs conflict in intent (simulated for this test)",
        conflictingSummary: "adds retry logic for the payments client",
        overlapPaths: [],
      },
    ],
  });

  const listRes = await app.request(`/v1/designs?projectId=proj-1&sessionId=s2`, { headers: bearer(admin.token) });
  const listBody = (await listRes.json()) as { items: { id: string; status: string }[] };
  const registered = listBody.items.find((d) => d.id === designId);
  assert.equal(registered?.status, "flagged", "a design flagged with an 'llm_divergence' verdict must not read back as 'open'");
});

// 2026-08-26: blocking is now a static function of verdict alone --
// file_overlap (tier 1's exactOverlap) always stays advisory. This is the
// counterpart to the test above, pinning that behavior for the same
// status/response-shape surface.
test("POST /v1/designs/check: a file_overlap (tier 1 exact) verdict stays status 'open', not 'flagged'", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "first, unrelated topic entirely", creates: ["a.ts"], touches: [], dependsOn: [] }),
  });
  const otherPat = await addProjectMember(app, admin.token, "proj-1"); // same-developer pairs no longer produce a file_overlap verdict at all (2026-08-22); must come after proj-1 is founded above
  const overlapRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(otherPat) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s2", summary: "second, also unrelated topic", creates: ["a.ts"], touches: [], dependsOn: [] }),
  });
  const overlapBody = (await overlapRes.json()) as { verdict: string; designId: string };
  assert.equal(overlapBody.verdict, "file_overlap");

  const listRes = await app.request(`/v1/designs?projectId=proj-1&sessionId=s2`, { headers: bearer(admin.token) });
  const listBody = (await listRes.json()) as { items: { id: string; status: string }[] };
  const registered = listBody.items.find((d) => d.id === overlapBody.designId);
  assert.equal(registered?.status, "open", "a file_overlap verdict must not demote the design out of 'open'");

  // Still visible for display -- the whole point of keeping it a flag at
  // all rather than silently dropping it.
  const activityRes = await app.request(`/v1/activity?projectId=proj-1&relatedId=${overlapBody.designId}`, { headers: bearer(admin.token) });
  const activityBody = (await activityRes.json()) as { items: { kind: string; payload?: { verdict?: string } }[] };
  const checked = activityBody.items.find((e) => e.kind === "design_checked");
  assert.ok(checked, "the check itself is still logged for the dashboard's activity feed");
  assert.equal(checked!.payload?.verdict, "file_overlap");
  assert.ok(!activityBody.items.some((e) => e.kind === "design_flagged"), "a file_overlap verdict must not also log design_flagged");
});

test("GET /v1/designs: newest-first, optionally filtered by status/sessionId", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  const register = async (sessionId: string, touches: string[]) => {
    const res = await app.request("/v1/designs/check", {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(admin.token) },
      body: JSON.stringify({ projectId: "proj-1", sessionId, summary: `design for ${sessionId}`, creates: [], touches, dependsOn: [], force: true }),
    });
    return (await res.json()) as { designId: string; verdict: string };
  };

  const first = await register("s1", ["a.ts"]);
  const second = await register("s2", ["b.ts"]);
  const third = await register("s3", ["c.ts"]);

  const listRes = await app.request(`/v1/designs?projectId=proj-1`, { headers: bearer(admin.token) });
  const { items } = (await listRes.json()) as { items: { id: string }[] };
  // Found live (2026-08-19): a plain unordered SQLite scan isn't reliably
  // insertion-order, so newly-registered designs were appearing at the
  // bottom of the dashboard's list instead of the top.
  assert.deepEqual(
    items.map((d) => d.id),
    [third.designId, second.designId, first.designId],
  );

  const filteredRes = await app.request(`/v1/designs?projectId=proj-1&sessionId=s2`, { headers: bearer(admin.token) });
  const { items: filtered } = (await filteredRes.json()) as { items: { id: string }[] };
  assert.deepEqual(
    filtered.map((d) => d.id),
    [second.designId],
  );
});

// Pagination (monitor UI load-time fix, 2026-08-29): GET /v1/designs used to
// return every design ever registered for a project, unbounded -- this
// exercises the new ?before=/?limit= cursor, mirroring GET /v1/activity's
// own shape.
test("GET /v1/designs: ?limit= paginates with a nextBefore cursor, walking every page reproduces the full unfiltered list", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  const register = async (sessionId: string) => {
    const res = await app.request("/v1/designs/check", {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(admin.token) },
      body: JSON.stringify({ projectId: "proj-1", sessionId, summary: sessionId, creates: [], touches: [`${sessionId}.ts`], dependsOn: [], force: true }),
    });
    return ((await res.json()) as { designId: string }).designId;
  };
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    ids.push(await register(`s${i}`));
    await new Promise((resolve) => setTimeout(resolve, 2)); // distinct createdAt per page boundary
  }
  ids.reverse();

  const fullRes = await app.request("/v1/designs?projectId=proj-1", { headers: bearer(admin.token) });
  const full = (await fullRes.json()) as { items: { id: string }[]; nextBefore?: number };
  assert.equal(full.items.length, 5, "default limit (20) covers all 5 -- no cursor needed");
  assert.equal(full.nextBefore, undefined);

  const page1Res = await app.request("/v1/designs?projectId=proj-1&limit=2", { headers: bearer(admin.token) });
  const page1 = (await page1Res.json()) as { items: { id: string }[]; nextBefore?: number };
  assert.deepEqual(
    page1.items.map((d) => d.id),
    ids.slice(0, 2),
  );
  assert.ok(page1.nextBefore !== undefined);

  const page2Res = await app.request(`/v1/designs?projectId=proj-1&limit=2&before=${page1.nextBefore}`, { headers: bearer(admin.token) });
  const page2 = (await page2Res.json()) as { items: { id: string }[]; nextBefore?: number };
  assert.deepEqual(
    page2.items.map((d) => d.id),
    ids.slice(2, 4),
  );

  const page3Res = await app.request(`/v1/designs?projectId=proj-1&limit=2&before=${page2.nextBefore}`, { headers: bearer(admin.token) });
  const page3 = (await page3Res.json()) as { items: { id: string }[]; nextBefore?: number };
  assert.deepEqual(
    page3.items.map((d) => d.id),
    ids.slice(4, 5),
  );
  assert.equal(page3.nextBefore, undefined, "last page carries no cursor");
});

test("GET /v1/designs: ?developerId= filters server-side, so 'mine only' stays correct across pages", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);
  const otherPat = await addProjectMember(app, admin.token, "proj-1");

  await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "admin's", creates: [], touches: ["a.ts"], dependsOn: [], force: true }),
  });
  await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(otherPat) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s2", summary: "other's", creates: [], touches: ["b.ts"], dependsOn: [], force: true }),
  });

  const res = await app.request(`/v1/designs?projectId=proj-1&developerId=${admin.developerId}`, { headers: bearer(admin.token) });
  const body = (await res.json()) as { items: { summary: string }[] };
  assert.deepEqual(
    body.items.map((d) => d.summary),
    ["admin's"],
  );
});

test("GET /v1/designs: an invalid ?before= or ?limit= is a 400", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);
  await app.request("/v1/claims", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", claims: [makeClaim({ projectId: "proj-1" })] }),
  });

  const badBefore = await app.request("/v1/designs?projectId=proj-1&before=not-a-number", { headers: bearer(admin.token) });
  assert.equal(badBefore.status, 400);
  const badLimit = await app.request("/v1/designs?projectId=proj-1&limit=not-a-number", { headers: bearer(admin.token) });
  assert.equal(badLimit.status, 400);
});

test("GET /v1/designs/:id: returns the design plus every groupMembers sibling the caller can see, omitting siblings in a project they can't", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  const firstRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-a", sessionId: "s1", summary: "repo-A half", creates: ["a.ts"], touches: [], dependsOn: [] }),
  });
  const first = (await firstRes.json()) as { designId: string; groupId?: string };

  const secondRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-b", sessionId: "s2", summary: "repo-B half", creates: ["b.ts"], touches: [], dependsOn: [], groupId: first.groupId }),
  });
  const second = (await secondRes.json()) as { designId: string };

  const res = await app.request(`/v1/designs/${first.designId}`, { headers: bearer(admin.token) });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { design: { id: string }; groupMembers: { id: string }[] };
  assert.equal(body.design.id, first.designId);
  assert.deepEqual(
    body.groupMembers.map((d) => d.id),
    [second.designId],
  );

  const notFoundRes = await app.request(`/v1/designs/no-such-id`, { headers: bearer(admin.token) });
  assert.equal(notFoundRes.status, 404);
});

test("GET /v1/designs/:id: 404s for a caller who's a member of some other real project, but not this design's own -- doesn't leak whether the id exists", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);
  const checkRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "", creates: ["a.ts"], touches: [], dependsOn: [] }),
  });
  const { designId } = (await checkRes.json()) as { designId: string };

  // Founds a second, unrelated project (admin becomes its member/admin too,
  // which doesn't matter here) purely so addProjectMember has a real
  // project to invite an outsider into -- that outsider is then a genuine
  // member of *something*, just never of proj-1.
  await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-other", sessionId: "s-other", summary: "", creates: ["z.ts"], touches: [], dependsOn: [] }),
  });
  const outsiderPat = await addProjectMember(app, admin.token, "proj-other");

  const res = await app.request(`/v1/designs/${designId}`, { headers: bearer(outsiderPat) });
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------------
// §17 design linking (groupId) -- 2026-08
// ---------------------------------------------------------------------------

test("POST /v1/designs/check: with no groupId in the body, the response self-assigns and echoes groupId === designId", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  const res = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "x", creates: ["a.ts"], touches: [], dependsOn: [] }),
  });
  const body = (await res.json()) as { verdict: string; designId: string; groupId?: string };
  assert.equal(body.groupId, body.designId);
});

test("POST /v1/designs/check: a caller-supplied groupId links a registration in a different project, echoed back on the overlap verdict branch too", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  const firstRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-a", sessionId: "s1", summary: "repo-A half", creates: ["a.ts"], touches: [], dependsOn: [] }),
  });
  const first = (await firstRes.json()) as { designId: string; groupId?: string };
  assert.equal(first.groupId, first.designId);

  const secondRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-b", sessionId: "s2", summary: "repo-B half", creates: ["b.ts"], touches: [], dependsOn: [], groupId: first.groupId }),
  });
  const second = (await secondRes.json()) as { verdict: string; designId: string; groupId?: string };
  assert.equal(second.verdict, "clean");
  assert.equal(second.groupId, first.groupId);

  // A different developer in proj-b registers a genuinely conflicting
  // design against `second`'s own scope, to exercise the "file_overlap" verdict
  // response branch specifically -- confirms groupId is echoed there too,
  // not just on the "clean" branch (a separate `c.json()` call in the
  // route that could otherwise be missed).
  const otherPat = await addProjectMember(app, admin.token, "proj-b");
  const conflictRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(otherPat) },
    body: JSON.stringify({ projectId: "proj-b", sessionId: "s3", summary: "conflicting", creates: ["b.ts"], touches: [], dependsOn: [] }),
  });
  const conflict = (await conflictRes.json()) as { verdict: string; designId: string; groupId?: string };
  assert.equal(conflict.verdict, "file_overlap");
  assert.equal(conflict.groupId, conflict.designId, "the conflicting design got its own default group, unrelated to the linked pair's");
});

test("POST /v1/designs/:id/amend: a summary update propagates to a linked sibling design in a different project", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  const firstRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-a", sessionId: "s1", summary: "repo-A original", creates: ["a.ts"], touches: [], dependsOn: [] }),
  });
  const first = (await firstRes.json()) as { designId: string; groupId?: string };

  const secondRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-b", sessionId: "s2", summary: "repo-B original", creates: ["b.ts"], touches: [], dependsOn: [], groupId: first.groupId }),
  });
  const second = (await secondRes.json()) as { designId: string };

  await withBedrockEnv(() =>
    withMockFetch(
      (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ conflict: false, kind: null, reason: "" }) } }] }), { status: 200 })) as typeof fetch,
      async () => {
        const amendRes = await app.request(`/v1/designs/${first.designId}/amend`, {
          method: "POST",
          headers: { "content-type": "application/json", ...bearer(admin.token) },
          body: JSON.stringify({ summary: "also handles pagination" }),
        });
        assert.equal(amendRes.status, 200);
      },
    ),
  );

  const listRes = await app.request(`/v1/designs?projectId=proj-b`, { headers: bearer(admin.token) });
  const { items } = (await listRes.json()) as { items: { id: string; summary: string }[] };
  const sibling = items.find((d) => d.id === second.designId);
  assert.match(sibling?.summary ?? "", /^repo-B original/, "sibling keeps its own original text");
  assert.match(sibling?.summary ?? "", /also handles pagination$/, "sibling gains its own appended update from the linked amend");
});

test("PATCH /v1/designs/:id/close: closing one design closes its linked sibling in a different project -- deliberately no membership check against the sibling's own project", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  const firstRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-a", sessionId: "s1", summary: "repo-A half", creates: ["a.ts"], touches: [], dependsOn: [] }),
  });
  const first = (await firstRes.json()) as { designId: string; groupId?: string };

  // `admin` here is a member of proj-a (via bootstrap) but has never
  // touched proj-b before this linked registration -- confirming the
  // sibling still closes anyway is the point: possessing the groupId is
  // treated as sufficient, this is the user's explicit trust decision for
  // this feature (see DesignRegistry.close's own comment), not an
  // oversight to be caught here.
  const secondRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-b", sessionId: "s2", summary: "repo-B half", creates: ["b.ts"], touches: [], dependsOn: [], groupId: first.groupId }),
  });
  const second = (await secondRes.json()) as { designId: string };

  const closeRes = await app.request(`/v1/designs/${first.designId}/close`, { method: "PATCH", headers: bearer(admin.token) });
  assert.equal(closeRes.status, 200);
  assert.deepEqual(await closeRes.json(), { status: "closed" });

  const listRes = await app.request(`/v1/designs?projectId=proj-b`, { headers: bearer(admin.token) });
  const { items } = (await listRes.json()) as { items: { id: string; status: string }[] };
  assert.equal(items.find((d) => d.id === second.designId)?.status, "closed");
});

test("GET /v1/designs: items include groupId", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  const res = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "x", creates: ["a.ts"], touches: [], dependsOn: [] }),
  });
  const { designId } = (await res.json()) as { designId: string };

  const listRes = await app.request(`/v1/designs?projectId=proj-1`, { headers: bearer(admin.token) });
  const { items } = (await listRes.json()) as { items: { id: string; groupId?: string }[] };
  const item = items.find((d) => d.id === designId);
  assert.equal(item?.groupId, designId);
});

// Critical regression guard: grouping two designs across different projects
// must NEVER let the gate's verdict logic compare across them -- openDesigns
// stays strictly scoped to one projectId regardless of a shared groupId.
test("POST /v1/designs/check: two linked designs in different projects with overlapping touches still verdict clean -- grouping never lets verdict logic compare across projects", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  const firstRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-a", sessionId: "s1", summary: "repo-A half", creates: [], touches: ["shared/path.ts"], dependsOn: [] }),
  });
  const first = (await firstRes.json()) as { designId: string; groupId?: string; verdict: string };
  assert.equal(first.verdict, "clean");

  const secondRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    // Deliberately the SAME path as `first`'s touches, in a DIFFERENT
    // project, linked via groupId -- if openDesigns or any overlap check
    // ever compared across projects because of the shared groupId, this
    // would come back "file_overlap" instead of "clean".
    body: JSON.stringify({ projectId: "proj-b", sessionId: "s2", summary: "repo-B half", creates: [], touches: ["shared/path.ts"], dependsOn: [], groupId: first.groupId }),
  });
  const second = (await secondRes.json()) as { designId: string; groupId?: string; verdict: string };
  assert.equal(second.verdict, "clean", "grouping must never suppress a real overlap, nor manufacture one across projects");
  assert.equal(second.groupId, first.groupId);
});

test("GET /v1/designs/scope-match: no_design, in_scope, out_of_scope, and flagged", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  const noDesign = await app.request(`/v1/designs/scope-match?projectId=proj-1&sessionId=s-never-registered&path=a.ts`, { headers: bearer(admin.token) });
  assert.deepEqual(await noDesign.json(), { state: "no_design" });

  const registerRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "", creates: [], touches: ["a.ts"], dependsOn: [] }),
  });
  const { designId } = (await registerRes.json()) as { designId: string };

  const inScope = await app.request(`/v1/designs/scope-match?projectId=proj-1&sessionId=s1&path=a.ts`, { headers: bearer(admin.token) });
  assert.deepEqual(await inScope.json(), { state: "in_scope", designId });

  const outOfScope = await app.request(`/v1/designs/scope-match?projectId=proj-1&sessionId=s1&path=z.ts`, { headers: bearer(admin.token) });
  assert.deepEqual(await outOfScope.json(), { state: "out_of_scope", designId, openDesigns: [{ id: designId, summary: "" }] });

  // A constraint match (tier 3, verdict constraint_violation), not tier 1
  // exact overlap -- file_overlap always stays advisory and never reaches
  // "flagged" (see the dedicated file_overlap test above).
  await app.request("/v1/constraints/seed", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", constraints: [{ statement: "protected path", scope: ["protected.ts"], type: "constraint" }] }),
  });
  const flaggedRegisterRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s2", summary: "", creates: [], touches: ["protected.ts"], dependsOn: [], force: true }),
  });
  const { designId: flaggedId, verdict: flaggedVerdict } = (await flaggedRegisterRes.json()) as { designId: string; verdict: string };
  assert.equal(flaggedVerdict, "constraint_violation");

  const flagged = await app.request(`/v1/designs/scope-match?projectId=proj-1&sessionId=s2&path=protected.ts`, { headers: bearer(admin.token) });
  // requiresAdmin: true because this design was flagged by a constraint
  // violation -- the one bucket that still needs an admin to clear. verdict
  // (2026-08-26, second pass) mirrors requiresAdmin's own source, read
  // directly off blockedReason now instead of reconstructed via an
  // activity-log join -- see blockedReason's doc comment (@twing/core).
  assert.deepEqual(await flagged.json(), { state: "flagged", designId: flaggedId, pendingReview: false, requiresAdmin: true, verdict: "constraint_violation" });

  // §17 review-flow fix (2026-08-16): pendingReview flips true once resolve
  // is called, without a decide -- the deny message needs to be able to
  // tell "never resolved" apart from "resolved, awaiting an admin".
  const resolveRes = await app.request(`/v1/designs/${flaggedId}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ resolution: "justified_divergence", justification: "intentional, reviewed" }),
  });
  assert.equal(resolveRes.status, 200);

  const flaggedAfterResolve = await app.request(`/v1/designs/scope-match?projectId=proj-1&sessionId=s2&path=protected.ts`, { headers: bearer(admin.token) });
  assert.deepEqual(await flaggedAfterResolve.json(), { state: "flagged", designId: flaggedId, pendingReview: true, requiresAdmin: true, verdict: "constraint_violation" });
});

// Found live (2026-08-25): with more than one open design in the same
// session, out_of_scope used to hand back a single `designId` picked as
// `openOnes[openOnes.length - 1]` -- since openOnes inherits listByProject's
// newest-first order, that's the *oldest* open design, not the newest/most
// likely one, and the hook had no way to see the others at all.
test("GET /v1/designs/scope-match: out_of_scope with more than one open design in the session lists every one, newest-first, not just the oldest", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  const firstRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "oldest task", creates: [], touches: ["a.ts"], dependsOn: [] }),
  });
  const { designId: firstId } = (await firstRes.json()) as { designId: string };

  const secondRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "newest task", creates: [], touches: ["b.ts"], dependsOn: [], force: true }),
  });
  const { designId: secondId } = (await secondRes.json()) as { designId: string };

  const outOfScope = await app.request(`/v1/designs/scope-match?projectId=proj-1&sessionId=s1&path=z.ts`, { headers: bearer(admin.token) });
  const body = (await outOfScope.json()) as { state: string; designId?: string; openDesigns?: { id: string; summary: string }[] };
  assert.equal(body.state, "out_of_scope");
  assert.equal(body.designId, secondId, "the single-designId hint must be the newest open design, not the oldest");
  assert.deepEqual(
    body.openDesigns,
    [
      { id: secondId, summary: "newest task" },
      { id: firstId, summary: "oldest task" },
    ],
    "every open design for the session must be listed, newest-first",
  );
});

test("GET /v1/designs/scope-match: with no ?path=, can only report no_design/flagged/in_scope (can't verify scope without a path)", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  const noPathNoDesign = await app.request(`/v1/designs/scope-match?projectId=proj-1&sessionId=s-never-registered`, { headers: bearer(admin.token) });
  assert.deepEqual(await noPathNoDesign.json(), { state: "no_design" });

  await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "", creates: [], touches: ["a.ts"], dependsOn: [] }),
  });
  const noPathInScope = await app.request(`/v1/designs/scope-match?projectId=proj-1&sessionId=s1`, { headers: bearer(admin.token) });
  const noPathBody = (await noPathInScope.json()) as { state: string; designId?: string };
  assert.equal(noPathBody.state, "in_scope");
  assert.equal(noPathBody.designId, undefined, "no designId hint when there's nothing to disambiguate a path against");
});

test("POST /v1/designs/check: a flagged design stays visible to a *third* design's overlap check (openDesigns includes flagged, end to end)", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  // "second" needs to actually reach status "flagged" to test what this
  // test is about -- since the 2026-08-19 severity split, a tier 1
  // (exactOverlap) hit alone no longer does that (warning severity, stays
  // "open"). So "second" is flagged via a constraint match (tier 3, error
  // severity) on a path first doesn't touch at all -- structuralOverlaps
  // against "first" must come back empty, or tier 1 would short-circuit
  // runDesignChecks before constraintMatch ever runs. "second" also touches
  // "shared.ts" so "third"'s own tier-1 check has something to find it by.
  await app.request("/v1/constraints/seed", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", constraints: [{ statement: "protected path", scope: ["constrained.ts"], type: "constraint" }] }),
  });
  // "third" is registered by a different developer than "second" -- same-
  // developer pairs no longer produce a tier-1 overlap verdict at all
  // (2026-08-22), which is what this test is actually exercising. Must come
  // after proj-1 is founded above (the seed call itself founds it).
  const thirdDeveloperPat = await addProjectMember(app, admin.token, "proj-1");
  await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "first", creates: [], touches: ["s1-only.ts"], dependsOn: [] }),
  });
  const secondRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s2", summary: "second", creates: [], touches: ["shared.ts", "constrained.ts"], dependsOn: [], force: true }),
  });
  const secondBody = (await secondRes.json()) as { verdict: string; designId: string };
  assert.equal(secondBody.verdict, "constraint_violation");

  const thirdRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(thirdDeveloperPat) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s3", summary: "third, also overlapping", creates: [], touches: ["shared.ts"], dependsOn: [] }),
  });
  const thirdBody = (await thirdRes.json()) as { verdict: string; conflicts: { conflictingDesignId: string }[] };
  assert.equal(thirdBody.verdict, "file_overlap", "a flagged design must not become invisible to new registrations' structural overlap checks");
  assert.ok(
    thirdBody.conflicts.some((c) => c.conflictingDesignId === secondBody.designId),
    "the flagged (second) design specifically should show up as a conflict, not just the still-open first one",
  );
});

test("POST /v1/designs/:id/amend: a clean amendment persists, bumps scopeVersion, and fires a fresh semantic-comparator pass", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  const registerRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "", creates: [], touches: ["a.ts"], dependsOn: [] }),
  });
  const { designId } = (await registerRes.json()) as { designId: string };

  await withBedrockEnv(() =>
    withMockFetch(
      (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ conflict: false, kind: null, reason: "" }) } }] }), { status: 200 })) as typeof fetch,
      async () => {
        const amendRes = await app.request(`/v1/designs/${designId}/amend`, {
          method: "POST",
          headers: { "content-type": "application/json", ...bearer(admin.token) },
          body: JSON.stringify({ addTouches: ["b.ts"] }),
        });
        assert.deepEqual(await amendRes.json(), { verdict: "clean", designId, groupId: designId });
      },
    ),
  );

  const scopeMatch = await app.request(`/v1/designs/scope-match?projectId=proj-1&sessionId=s1&path=b.ts`, { headers: bearer(admin.token) });
  assert.deepEqual(await scopeMatch.json(), { state: "in_scope", designId });

  const listRes = await app.request(`/v1/designs?projectId=proj-1&sessionId=s1`, { headers: bearer(admin.token) });
  const listBody = (await listRes.json()) as { items: { id: string; touches: string[] }[] };
  assert.deepEqual(listBody.items.find((d) => d.id === designId)?.touches, ["a.ts", "b.ts"]);
});

test("POST /v1/designs/:id/amend: a summary-only amendment appends an Update entry (never drops the original) and leaves touches/creates/dependsOn untouched", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  const registerRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "placeholder", creates: [], touches: ["a.ts"], dependsOn: [] }),
  });
  const { designId } = (await registerRes.json()) as { designId: string };

  await withBedrockEnv(() =>
    withMockFetch(
      (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ conflict: false, kind: null, reason: "" }) } }] }), { status: 200 })) as typeof fetch,
      async () => {
        const amendRes = await app.request(`/v1/designs/${designId}/amend`, {
          method: "POST",
          headers: { "content-type": "application/json", ...bearer(admin.token) },
          body: JSON.stringify({ summary: "the corrected summary" }),
        });
        assert.deepEqual(await amendRes.json(), { verdict: "clean", designId, groupId: designId });
      },
    ),
  );

  const listRes = await app.request(`/v1/designs?projectId=proj-1&sessionId=s1`, { headers: bearer(admin.token) });
  const listBody = (await listRes.json()) as { items: { id: string; summary: string; touches: string[] }[] };
  const amended = listBody.items.find((d) => d.id === designId);
  assert.match(amended?.summary ?? "", /^placeholder\n\nUpdate \(\d{4}-\d{2}-\d{2}\): the corrected summary$/, "original summary must survive, new text appended as a dated Update entry");
  assert.deepEqual(amended?.touches, ["a.ts"], "amend --summary alone must not touch the existing scope");
});

test("POST /v1/designs/:id/amend: a groupId-only body joins a group after the fact, and doesn't hit the 400 guard", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  const anchorRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-a", sessionId: "s1", summary: "anchor", creates: [], touches: ["a.ts"], dependsOn: [] }),
  });
  const anchor = (await anchorRes.json()) as { designId: string; groupId?: string };

  const soloRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-b", sessionId: "s2", summary: "was solo", creates: [], touches: ["b.ts"], dependsOn: [], force: true }),
  });
  const solo = (await soloRes.json()) as { designId: string; groupId?: string };
  assert.equal(solo.groupId, solo.designId, "starts as its own group of one");

  const amendRes = await app.request(`/v1/designs/${solo.designId}/amend`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ groupId: anchor.designId }),
  });
  assert.equal(amendRes.status, 200);
  const amendBody = (await amendRes.json()) as { verdict: string; groupId?: string };
  assert.equal(amendBody.verdict, "clean");
  assert.equal(amendBody.groupId, anchor.designId);

  const listRes = await app.request(`/v1/designs?projectId=proj-b`, { headers: bearer(admin.token) });
  const { items } = (await listRes.json()) as { items: { id: string; groupId?: string }[] };
  assert.equal(items.find((d) => d.id === solo.designId)?.groupId, anchor.designId);
});

test("POST /v1/designs/:id/amend: a groupId-only amend never touches conflict detection at all -- it's routed to relink(), not checkAmendedScope", async () => {
  // §17 design linking follow-up (2026-08-28): a groupId-only delta now
  // short-circuits to DesignRegistry.relink() before checkAmendedScope
  // ever runs (see the amend route's hasScopeChange branch) -- this used
  // to exercise "the delta reaches checkAmendedScope but is a no-op
  // there"; now it exercises "checkAmendedScope is never reached in the
  // first place". Still asserts the same clean/groupId outcome, which is
  // what actually matters to a caller.
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  const anchorRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-a", sessionId: "s1", summary: "anchor", creates: [], touches: ["a.ts"], dependsOn: [] }),
  });
  const anchor = (await anchorRes.json()) as { designId: string };

  const targetRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-b", sessionId: "s2", summary: "target", creates: [], touches: ["b.ts"], dependsOn: [], force: true }),
  });
  const target = (await targetRes.json()) as { designId: string; verdict: string };
  assert.equal(target.verdict, "clean", "sanity: unrelated projects/paths, nothing to conflict with");

  const amendRes = await app.request(`/v1/designs/${target.designId}/amend`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ groupId: anchor.designId }),
  });
  const amendBody = (await amendRes.json()) as { verdict: string; groupId?: string };
  assert.equal(amendBody.verdict, "clean");
  assert.equal(amendBody.groupId, anchor.designId);
});

// §17 design linking follow-up (2026-08-28): groupId was previously only
// settable at registration or via amend() on an *open* design -- an
// already-closed design (the common terminal state) had no path at all to
// join a group. relink() is the fix; these two exercise the route's new
// branch directly.
test("POST /v1/designs/:id/amend: a groupId-only body still succeeds against a CLOSED design -- this is the whole point of relink()", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  const anchorRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-a", sessionId: "s1", summary: "anchor", creates: [], touches: ["a.ts"], dependsOn: [] }),
  });
  const anchor = (await anchorRes.json()) as { designId: string };

  const targetRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-b", sessionId: "s2", summary: "target", creates: [], touches: ["b.ts"], dependsOn: [], force: true }),
  });
  const target = (await targetRes.json()) as { designId: string };

  const closeRes = await app.request(`/v1/designs/${target.designId}/close`, { method: "PATCH", headers: bearer(admin.token) });
  assert.equal((await closeRes.json() as { status?: string }).status, "closed");

  const amendRes = await app.request(`/v1/designs/${target.designId}/amend`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ groupId: anchor.designId }),
  });
  assert.equal(amendRes.status, 200);
  const amendBody = (await amendRes.json()) as { verdict: string; groupId?: string };
  assert.equal(amendBody.verdict, "clean");
  assert.equal(amendBody.groupId, anchor.designId);

  const listRes = await app.request(`/v1/designs?projectId=proj-b`, { headers: bearer(admin.token) });
  const { items } = (await listRes.json()) as { items: { id: string; groupId?: string; status: string }[] };
  const persisted = items.find((d) => d.id === target.designId);
  assert.equal(persisted?.groupId, anchor.designId);
  assert.equal(persisted?.status, "closed", "relink doesn't reopen the design");
});

test("POST /v1/designs/:id/amend: a CLOSED design with a real scope change (not groupId-only) still 409s -- the escape hatch is groupId-only, not a general reopen", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  const targetRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-a", sessionId: "s1", summary: "target", creates: [], touches: ["a.ts"], dependsOn: [] }),
  });
  const target = (await targetRes.json()) as { designId: string };
  await app.request(`/v1/designs/${target.designId}/close`, { method: "PATCH", headers: bearer(admin.token) });

  // groupId + a real scope change together -- hasScopeChange is true, so
  // this must NOT be treated as the groupId-only case.
  const amendRes = await app.request(`/v1/designs/${target.designId}/amend`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ groupId: target.designId, addTouches: ["b.ts"] }),
  });
  assert.equal(amendRes.status, 409);
  const body = (await amendRes.json()) as { error?: string };
  assert.match(body.error ?? "", /closed, not open -- can't amend/);
});

test("POST /v1/designs/:id/amend: neither a scope delta nor a summary is a 400, not a silent no-op", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  const registerRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "x", creates: [], touches: ["a.ts"], dependsOn: [] }),
  });
  const { designId } = (await registerRes.json()) as { designId: string };

  const amendRes = await app.request(`/v1/designs/${designId}/amend`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({}),
  });
  assert.equal(amendRes.status, 400);
});

test("POST /v1/designs/:id/amend: a conflicting amendment persists the merged scope and flags the design, instead of silently discarding it", async () => {
  // Found live (2026-08): this used to leave the design's row completely
  // untouched on a non-clean verdict, unlike a fresh /v1/designs/check
  // registration (which always persists its proposed scope, then flags).
  // That asymmetry meant `resolve --justify` + an approved review had
  // nothing to reopen -- see the next test for the full loop this enables.
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  // A constraint match (tier 3, error severity), not tier 1 exact overlap --
  // since the 2026-08-19 severity split, tier 1 alone would leave this
  // amendment "open" rather than "flagged" (see the dedicated
  // warning-severity amend test below).
  await app.request("/v1/constraints/seed", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", constraints: [{ statement: "protected path", scope: ["constrained.ts"], type: "constraint" }] }),
  });
  const registerRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "", creates: [], touches: ["a.ts"], dependsOn: [] }),
  });
  const { designId } = (await registerRes.json()) as { designId: string };

  const amendRes = await app.request(`/v1/designs/${designId}/amend`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ addTouches: ["constrained.ts"] }),
  });
  const amendBody = (await amendRes.json()) as { verdict: string; designId: string };
  assert.equal(amendBody.verdict, "constraint_violation");

  // Demoted out of "open" (not usable for the gate) but addressable, and --
  // the actual fix -- its scope now reflects exactly what was proposed, not
  // the pre-amend scope, so a later review approval has something real to
  // reopen.
  const listRes = await app.request(`/v1/designs?projectId=proj-1&sessionId=s1`, { headers: bearer(admin.token) });
  const listBody = (await listRes.json()) as { items: { id: string; status: string; touches: string[] }[] };
  const design = listBody.items.find((d) => d.id === designId);
  assert.equal(design?.status, "flagged");
  assert.deepEqual(design?.touches, ["a.ts", "constrained.ts"]);
});

// 2026-08-19 severity split: same shape as above, but a warning-severity
// (tier 1) amendment must persist and stay "open" -- no flag, no review
// needed, matching a fresh registration's warning-severity behavior.
test("POST /v1/designs/:id/amend: a file_overlap (tier 1 exact) amendment persists and stays 'open'", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);
  const otherPat = await addProjectMember(app, admin.token, "proj-1"); // same-developer pairs no longer produce an overlap verdict at all (2026-08-22)

  await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(otherPat) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s-other", summary: "unrelated topic", creates: [], touches: ["shared.ts"], dependsOn: [] }),
  });
  const registerRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "also unrelated", creates: [], touches: ["a.ts"], dependsOn: [] }),
  });
  const { designId } = (await registerRes.json()) as { designId: string };

  const amendRes = await app.request(`/v1/designs/${designId}/amend`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ addTouches: ["shared.ts"] }),
  });
  const amendBody = (await amendRes.json()) as { verdict: string; designId: string };
  assert.equal(amendBody.verdict, "file_overlap");

  const listRes = await app.request(`/v1/designs?projectId=proj-1&sessionId=s1`, { headers: bearer(admin.token) });
  const listBody = (await listRes.json()) as { items: { id: string; status: string; touches: string[] }[] };
  const design = listBody.items.find((d) => d.id === designId);
  assert.equal(design?.status, "open", "a file_overlap amend must not demote the design out of 'open'");
  assert.deepEqual(design?.touches, ["a.ts", "shared.ts"], "the proposed scope still persists even though it's only a warning");

  // Found while updating twing-monitor for the severity split: since
  // design_flagged is (correctly) skipped for a warning, without a
  // dedicated log here a warning-severity amend left zero activity trail
  // at all -- design_amended's own event only ever carries the scope
  // delta, never the check outcome.
  const activityRes = await app.request(`/v1/activity?projectId=proj-1&relatedId=${designId}`, { headers: bearer(admin.token) });
  const activityBody = (await activityRes.json()) as { items: { kind: string; payload?: { verdict?: string } }[] };
  const checked = activityBody.items.find((e) => e.kind === "design_checked");
  assert.ok(checked, "a file_overlap amend must still log a design_checked event explaining why");
  assert.equal(checked!.payload?.verdict, "file_overlap");
  assert.ok(!activityBody.items.some((e) => e.kind === "design_flagged"), "a file_overlap amend must not also log design_flagged");
});

test("POST /v1/designs/:id/amend: a rejected amend's proposed scope survives an approved review -- decideReview reopens it intact, not empty-handed", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s-other", summary: "", creates: [], touches: ["shared.ts"], dependsOn: [] }),
  });
  const registerRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "", creates: [], touches: ["a.ts"], dependsOn: [], force: true }),
  });
  const { designId } = (await registerRes.json()) as { designId: string };

  await app.request(`/v1/designs/${designId}/amend`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ addTouches: ["shared.ts"] }),
  });

  const resolveRes = await app.request(`/v1/designs/${designId}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ resolution: "justified_divergence", justification: "intentional, both legitimately touch shared.ts" }),
  });
  const { reviewId } = (await resolveRes.json()) as { reviewId: string };

  const decideRes = await app.request(`/v1/reviews/${reviewId}/decide`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ decision: "approve" }),
  });
  assert.equal(decideRes.status, 200);

  const listRes = await app.request(`/v1/designs?projectId=proj-1&sessionId=s1`, { headers: bearer(admin.token) });
  const listBody = (await listRes.json()) as { items: { id: string; status: string; touches: string[] }[] };
  const design = listBody.items.find((d) => d.id === designId);
  assert.equal(design?.status, "open", "approval must reopen the design");
  assert.deepEqual(
    design?.touches,
    ["a.ts", "shared.ts"],
    "the proposed scope must survive into the reopened design -- this is the actual bug: previously nothing was ever persisted for approval to reopen",
  );
});

test("POST /v1/designs/:id/amend: an approved review waives only that specific constraint -- a later, different constraint still flags", async () => {
  // Proves the precision of justifiedConstraintIds: approving one
  // constraint match must not silently waive every future constraint on
  // the same design.
  const { app, dataDir, constraints } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);
  constraints.add("proj-1", "needs review A", ["a/**"], "constraint", "seeded");
  constraints.add("proj-1", "needs review B", ["b/**"], "constraint", "seeded");

  const registerRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "", creates: [], touches: ["x.ts"], dependsOn: [] }),
  });
  const { designId } = (await registerRes.json()) as { designId: string };

  const firstAmend = await app.request(`/v1/designs/${designId}/amend`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ addTouches: ["a/one.ts"] }),
  });
  assert.equal((await firstAmend.json() as { verdict: string }).verdict, "constraint_violation");

  const resolveRes = await app.request(`/v1/designs/${designId}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ resolution: "justified_divergence", justification: "a/** is fine here" }),
  });
  const { reviewId } = (await resolveRes.json()) as { reviewId: string };
  await app.request(`/v1/reviews/${reviewId}/decide`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ decision: "approve" }),
  });

  // Re-amending with no new delta beyond what's already justified should
  // now come back clean -- the whole point of this fix.
  const secondAmend = await app.request(`/v1/designs/${designId}/amend`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ addTouches: ["a/two.ts"] }),
  });
  assert.equal((await secondAmend.json() as { verdict: string }).verdict, "clean", "a/** was already justified for this design -- must not re-flag");

  // But a genuinely different constraint (b/**) must still flag normally.
  const thirdAmend = await app.request(`/v1/designs/${designId}/amend`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ addTouches: ["b/one.ts"] }),
  });
  assert.equal((await thirdAmend.json() as { verdict: string }).verdict, "constraint_violation", "b/** was never justified -- approving a/** must not waive it too");
});

test("POST /v1/designs/:id/resolve: an approved structural overlap on one path doesn't re-flag on a later amend, but a newly-added overlapping path on the same pair still flags fresh (item 7's fix)", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);
  const otherPat = await addProjectMember(app, admin.token, "proj-1"); // same-developer pairs no longer produce an overlap verdict at all (2026-08-22)

  // The other design claims both file1.ts and file2.ts from the start.
  await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(otherPat) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s-other", summary: "", creates: [], touches: ["file1.ts", "file2.ts"], dependsOn: [] }),
  });

  const registerRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "", creates: [], touches: ["file1.ts"], dependsOn: [] }),
  });
  const { verdict: firstVerdict, designId } = (await registerRes.json()) as { verdict: string; designId: string };
  assert.equal(firstVerdict, "file_overlap", "sanity: file1.ts overlap must be caught first");

  const resolveRes = await app.request(`/v1/designs/${designId}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ resolution: "justified_divergence", justification: "proceeding on file1.ts despite the overlap" }),
  });
  const { reviewId } = (await resolveRes.json()) as { reviewId: string };
  await app.request(`/v1/reviews/${reviewId}/decide`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ decision: "approve" }),
  });

  // Amending to also touch file2.ts re-runs the check against the design's
  // *entire* merged scope (file1.ts + file2.ts), not just the delta -- if
  // file1.ts's approval weren't remembered, this would report both paths
  // as conflicts, not just the genuinely new one.
  const amendRes = await app.request(`/v1/designs/${designId}/amend`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ addTouches: ["file2.ts"] }),
  });
  const amendBody = (await amendRes.json()) as { verdict: string; conflicts: { overlapPaths: string[] }[] };
  assert.equal(amendBody.verdict, "file_overlap", "file2.ts was never justified -- approving file1.ts must not waive it too");
  assert.deepEqual(amendBody.conflicts[0].overlapPaths, ["file2.ts"], "file1.ts's already-approved overlap must not resurface");
});

test("POST /v1/designs/:id/resolve: attributes constraintId even when the design *also* overlaps another open design on the same path", async () => {
  // Regression test for a real bug found live, 2026-08-17: resolve() used
  // to derive constraintId by re-running the *overall* verdict check
  // (checkAmendedScope) and only attributing a constraint when that
  // recomputed verdict came back exactly "constraint_violation". But
  // runDesignChecks returns tier-1 "file_overlap" before it ever reaches
  // tier-3's constraint match, so a design that both touches a flagged
  // path *and* happens to overlap some other open design on that same
  // path got constraintId silently dropped -- the approved review then had
  // nothing to add to justifiedConstraintIds, so the ground-truth
  // /v1/constraints/match backstop kept denying identically forever, even
  // after approval. The fix matches constraints directly against the
  // design's own scope, independent of whatever else is open.
  const { app, dataDir, constraints } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);
  const constraint = constraints.add("proj-1", "needs review", ["shared.ts"], "constraint", "seeded");
  const otherPat = await addProjectMember(app, admin.token, "proj-1"); // same-developer pairs no longer produce an overlap verdict at all (2026-08-22)

  // A second open design that also touches shared.ts -- this is what
  // creates the overlap tier-1 hit alongside the constraint match.
  await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(otherPat) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s-other", summary: "", creates: [], touches: ["shared.ts"], dependsOn: [] }),
  });

  const registerRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "", creates: [], touches: ["shared.ts"], dependsOn: [] }),
  });
  const { verdict, designId } = (await registerRes.json()) as { verdict: string; designId: string };
  assert.equal(verdict, "file_overlap", "sanity check: registration itself must see the overlap, not the constraint, since tier 1 wins");

  const resolveRes = await app.request(`/v1/designs/${designId}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ resolution: "justified_divergence", justification: "both legitimately touch shared.ts, and it's a reviewed path" }),
  });
  const { reviewId } = (await resolveRes.json()) as { reviewId: string };

  await app.request(`/v1/reviews/${reviewId}/decide`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ decision: "approve" }),
  });

  const listRes = await app.request(`/v1/designs?projectId=proj-1&sessionId=s1`, { headers: bearer(admin.token) });
  const listBody = (await listRes.json()) as { items: { id: string; justifiedConstraintIds: string[] }[] };
  const design = listBody.items.find((d) => d.id === designId);
  assert.deepEqual(
    design?.justifiedConstraintIds,
    [constraint.id],
    "the constraint must be attributed and recorded despite the concurrent overlap -- this is the actual bug",
  );

  // And the ground-truth backstop must now actually honor it.
  const matchRes = await app.request(`/v1/constraints/match?projectId=proj-1&path=shared.ts&sessionId=s1`, { headers: bearer(admin.token) });
  assert.deepEqual(await matchRes.json(), { matched: false, constraints: [] }, "an approved, attributed constraint must be excluded from the ground-truth check");
});

test("GET /v1/constraints/match: an already-approved constraint stays honored even after the design gets re-flagged for something unrelated", async () => {
  // Regression test for a real bug found live, 2026-08-26: the exclude-list
  // computation below only ever read `justifiedConstraintIds` off designs
  // with `status === "open"`. A design's approval history is durable and
  // never revoked -- but the moment that same design got re-flagged for
  // anything else (e.g. a later, unrelated symbol_conflict from ongoing
  // background activity), this endpoint stopped consulting its
  // justifiedConstraintIds at all, so the already-approved constraint
  // started matching again as if it had never been cleared. Fixed by
  // widening the eligibility filter to match /v1/designs/scope-match's own
  // (open, flagged, or dormant -- never closed/superseded/expired).
  const { app, dataDir, designs, constraints } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);
  const constraint = constraints.add("proj-1", "needs review", ["shared.ts"], "constraint", "seeded");

  const registerRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "", creates: [], touches: ["shared.ts"], dependsOn: [] }),
  });
  const { designId } = (await registerRes.json()) as { designId: string };

  const resolveRes = await app.request(`/v1/designs/${designId}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ resolution: "justified_divergence", justification: "reviewed path, approved" }),
  });
  const { reviewId } = (await resolveRes.json()) as { reviewId: string };
  await app.request(`/v1/reviews/${reviewId}/decide`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ decision: "approve" }),
  });

  const beforeReflag = await app.request(`/v1/constraints/match?projectId=proj-1&path=shared.ts&sessionId=s1`, { headers: bearer(admin.token) });
  assert.deepEqual(await beforeReflag.json(), { matched: false, constraints: [] }, "sanity check: approval honored while still open");

  // Simulate the unrelated re-flag directly (mirrors what a later
  // symbol_conflict/llm_divergence pass does via designs.flag()) --
  // justifiedConstraintIds is untouched, only status moves off "open".
  designs.flag(designId, "symbol_conflict", {});
  assert.equal(designs.get(designId)?.status, "flagged", "sanity check: the design really is flagged now");
  assert.deepEqual(
    designs.get(designId)?.justifiedConstraintIds,
    [constraint.id],
    "sanity check: the earlier approval is still on the row, untouched by the re-flag",
  );

  const afterReflag = await app.request(`/v1/constraints/match?projectId=proj-1&path=shared.ts&sessionId=s1`, { headers: bearer(admin.token) });
  assert.deepEqual(
    await afterReflag.json(),
    { matched: false, constraints: [] },
    "an already-approved constraint must stay excluded even while the design is flagged for something else",
  );
});

test("POST /v1/designs/:id/amend: supersedes a still-running semantic-comparator pass from the prior registration (kill stale, retain findings, start fresh)", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);
  // A different developer than "s-candidate" below -- the semantic
  // comparator skips same-developer pairs entirely now (2026-08-22), which
  // would leave `calls` at 0 throughout and this test asserting nothing real.
  const otherPat = await addProjectMember(app, admin.token, "proj-1");

  await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(otherPat) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s-other1", summary: "", creates: [], touches: ["other1.ts"], dependsOn: [] }),
  });
  await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(otherPat) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s-other2", summary: "", creates: [], touches: ["other2.ts"], dependsOn: [], force: true }),
  });

  let calls = 0;
  let releaseFirstCall!: () => void;
  const firstCallRelease = new Promise<void>((resolve) => {
    releaseFirstCall = resolve;
  });

  await withBedrockEnv(async () => {
    await withMockFetch(
      (async () => {
        calls++;
        if (calls === 1) {
          await firstCallRelease; // pause the stale run's first (in-flight) comparison
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ conflict: false, kind: null, reason: "" }) } }] }), { status: 200 });
      }) as typeof fetch,
      async () => {
        const registerRes = await app.request("/v1/designs/check", {
          method: "POST",
          headers: { "content-type": "application/json", ...bearer(admin.token) },
          body: JSON.stringify({ projectId: "proj-1", sessionId: "s-candidate", summary: "", creates: [], touches: ["candidate.ts"], dependsOn: [] }),
        });
        const { designId } = (await registerRes.json()) as { designId: string };

        // Give the fire-and-forget pass a moment to actually start its first
        // (now-paused) comparison call before amending underneath it.
        await waitFor(() => calls >= 1);

        const amendRes = await app.request(`/v1/designs/${designId}/amend`, {
          method: "POST",
          headers: { "content-type": "application/json", ...bearer(admin.token) },
          body: JSON.stringify({ addTouches: ["candidate2.ts"] }),
        });
        assert.equal((await amendRes.json()).verdict, "clean");

        releaseFirstCall(); // let the stale, now-superseded call finish

        // Stale run: 1 call (other1), then its next iteration sees the
        // bumped scopeVersion and stops -- it never reaches other2. Fresh
        // run (from amend): 2 calls (other1 + other2, recompared in full).
        await waitFor(() => calls === 3);
        // Give a superseded stale run a further beat to (incorrectly) fire
        // a second call, if the version guard were broken.
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(calls, 3, "the stale pass must not have compared against other2 after being superseded");
      },
    );
  });
});

// --- §17 design lifecycle (2026-08): dormancy, touch, resume, stale-sibling notice ---

// Tightening alignment threads, item 4 (2026-08-27): the alignment thread
// itself is built directly via the store (not the real Bedrock-mocked
// comparator pass) since this is about the dormancy trigger's plumbing
// (DesignRegistry.sweepExpired's onDesignsWentDormant hook, reacted to in
// app.ts's maybeDormThread), not the LLM's own judgment -- same pattern
// used for the item 3 tests above.
test("DesignRegistry.sweepExpired demoting a design to dormant also demotes its shared alignment thread, once the other side has already settled", async () => {
  const { app, dataDir, designs, alignmentThreads } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir); // alice

  const aliceRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s-alice", summary: "alice's work", creates: [], touches: ["a.ts"], dependsOn: [] }),
  });
  const { designId: aliceDesignId } = (await aliceRes.json()) as { designId: string };

  const otherPat = await addProjectMember(app, admin.token, "proj-1");
  const bobRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(otherPat) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s-bob", summary: "bob's work", creates: [], touches: ["b.ts"], dependsOn: [], ttlMs: 10 }),
  });
  const { designId: bobDesignId } = (await bobRes.json()) as { designId: string };

  const thread = alignmentThreads.findOrCreate({
    projectId: "proj-1",
    symbolIds: [],
    developerId: admin.developerId,
    otherDeveloperId: "bob@example.com",
    designId: bobDesignId,
    systemDescription: "they fight over the same guarantee",
    category: "llm_divergence",
    subKind: "tension",
    summary: "alice's work vs bob's work",
    initiatingDesignId: aliceDesignId,
    ts: Date.now(),
    reopenEligible: false,
  });
  designs.flag(aliceDesignId, "llm_divergence", { conflicts: [{ conflictingDesignId: bobDesignId, overlapKind: "touches", overlapDetail: "tension", conflictingSummary: "bob's work", overlapPaths: [] }] });
  designs.flag(bobDesignId, "llm_divergence", { conflicts: [{ conflictingDesignId: aliceDesignId, overlapKind: "touches", overlapDetail: "tension", conflictingSummary: "alice's work", overlapPaths: [] }] });

  // Alice resolves her side; bob just never comes back.
  const resolveRes = await app.request(`/v1/designs/${aliceDesignId}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ resolution: "justified_divergence", justification: "reviewed, proceeding" }),
  });
  assert.equal((await resolveRes.json() as { status: string }).status, "resolved");

  const beforeRes = await app.request(`/v1/alignment-threads/${thread.id}`, { headers: bearer(admin.token) });
  assert.equal(((await beforeRes.json()) as { thread: { status: string } }).thread.status, "open", "sanity: bob hasn't gone dormant yet");

  designs.sweepExpired(Date.now() + 1000); // well past bob's 10ms ttlMs -- forces his design dormant

  const afterRes = await app.request(`/v1/alignment-threads/${thread.id}`, { headers: bearer(admin.token) });
  const afterBody = (await afterRes.json()) as { thread: { status: string }; messages: { message: string }[] };
  assert.equal(afterBody.thread.status, "dormant", "alice already resolved, bob just went quiet -- the thread should follow him into dormant, not stay open or jump to closed");
  assert.ok(afterBody.messages.some((m) => m.message.includes("Dormant")));

  // The symmetric wake-up: resuming bob's design brings the thread back.
  const resumeRes = await app.request(`/v1/designs/${bobDesignId}/resume`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(otherPat) },
    body: JSON.stringify({ sessionId: "s-bob-2" }),
  });
  assert.equal((await resumeRes.json() as { verdict: string }).verdict, "clean");

  const wokenRes = await app.request(`/v1/alignment-threads/${thread.id}`, { headers: bearer(admin.token) });
  const wokenBody = (await wokenRes.json()) as { thread: { status: string }; messages: { message: string }[] };
  assert.equal(wokenBody.thread.status, "open", "resuming bob's design should wake the thread back up");
  assert.ok(wokenBody.messages.some((m) => m.message.includes("Reopened")));
});

// The guard rail on the other side of the same trigger: one party going
// quiet must not silently sweep a thread out of sight while the other side
// is still genuinely blocked and waiting on it.
test("DesignRegistry.sweepExpired demoting one side to dormant leaves the thread open while the other side is still actively flagged", async () => {
  const { app, dataDir, designs, alignmentThreads } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir); // alice

  const aliceRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s-alice", summary: "alice's work", creates: [], touches: ["a.ts"], dependsOn: [] }),
  });
  const { designId: aliceDesignId } = (await aliceRes.json()) as { designId: string };

  const otherPat = await addProjectMember(app, admin.token, "proj-1");
  const bobRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(otherPat) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s-bob", summary: "bob's work", creates: [], touches: ["b.ts"], dependsOn: [], ttlMs: 10 }),
  });
  const { designId: bobDesignId } = (await bobRes.json()) as { designId: string };

  const thread = alignmentThreads.findOrCreate({
    projectId: "proj-1",
    symbolIds: [],
    developerId: admin.developerId,
    otherDeveloperId: "bob@example.com",
    designId: bobDesignId,
    systemDescription: "they fight over the same guarantee",
    category: "llm_divergence",
    subKind: "tension",
    summary: "alice's work vs bob's work",
    initiatingDesignId: aliceDesignId,
    ts: Date.now(),
    reopenEligible: false,
  });
  // Neither side ever resolves -- alice's design stays actively flagged.
  designs.flag(aliceDesignId, "llm_divergence", { conflicts: [{ conflictingDesignId: bobDesignId, overlapKind: "touches", overlapDetail: "tension", conflictingSummary: "bob's work", overlapPaths: [] }] });
  designs.flag(bobDesignId, "llm_divergence", { conflicts: [{ conflictingDesignId: aliceDesignId, overlapKind: "touches", overlapDetail: "tension", conflictingSummary: "alice's work", overlapPaths: [] }] });

  designs.sweepExpired(Date.now() + 1000); // only bob's 10ms ttlMs has elapsed -- alice's design has no ttlMs override, still fresh

  const afterRes = await app.request(`/v1/alignment-threads/${thread.id}`, { headers: bearer(admin.token) });
  const afterBody = (await afterRes.json()) as { thread: { status: string } };
  assert.equal(afterBody.thread.status, "open", "alice's side is still actively flagged and live -- bob alone going quiet must not sweep this thread out of sight");
});

test("GET /v1/designs/scope-match: dormant state end-to-end, with summary and dormantSinceMs", async () => {
  const { app, dataDir, designs } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  const registerRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "old plan", creates: [], touches: ["a.ts"], dependsOn: [], ttlMs: 10 }),
  });
  const { designId } = (await registerRes.json()) as { designId: string };

  designs.sweepExpired(Date.now() + 1000); // well past the 10ms active TTL -- forces the dormant transition

  const scopeMatch = await app.request(`/v1/designs/scope-match?projectId=proj-1&sessionId=s1&path=a.ts`, { headers: bearer(admin.token) });
  const body = (await scopeMatch.json()) as { state: string; designId?: string; summary?: string; dormantSinceMs?: number };
  assert.equal(body.state, "dormant");
  assert.equal(body.designId, designId);
  assert.equal(body.summary, "old plan");
  assert.ok(typeof body.dormantSinceMs === "number" && body.dormantSinceMs >= 0);
});

// Found live (2026-08-26): dormant was checked before flagged, so a session
// carrying any dormant design at all could never learn about a real,
// possibly admin-gated, flagged/pending-review block sitting right next to
// it -- it always got told to `design resume` the dormant one instead,
// which silently reactivates unrelated stale work while hiding the actual
// blocker. Flagged must now win.
test("GET /v1/designs/scope-match: a flagged design takes priority over a dormant one in the same session", async () => {
  const { app, dataDir, designs } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  const dormantRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "old plan", creates: [], touches: ["a.ts"], dependsOn: [], ttlMs: 10 }),
  });
  const { designId: dormantId } = (await dormantRes.json()) as { designId: string };
  designs.sweepExpired(Date.now() + 1000); // -> dormant

  await app.request("/v1/constraints/seed", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", constraints: [{ statement: "protected path", scope: ["protected.ts"], type: "constraint" }] }),
  });
  const flaggedRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "new plan", creates: [], touches: ["protected.ts"], dependsOn: [], force: true }),
  });
  const { designId: flaggedId, verdict } = (await flaggedRes.json()) as { designId: string; verdict: string };
  assert.equal(verdict, "constraint_violation");

  // Before the fix, this returned "dormant" and never mentioned the
  // constraint-violation block right next to it.
  const scopeMatch = await app.request(`/v1/designs/scope-match?projectId=proj-1&sessionId=s1&path=z.ts`, { headers: bearer(admin.token) });
  const body = (await scopeMatch.json()) as { state: string; designId?: string; requiresAdmin?: boolean };
  assert.equal(body.state, "flagged");
  assert.equal(body.designId, flaggedId);
  assert.notEqual(body.designId, dormantId);
  assert.equal(body.requiresAdmin, true);
});

// The block is session-wide regardless of which flagged design gets named,
// but the named design should still be the one actually relevant to `path`
// when more than one is flagged -- same "prefer a scope match, only then
// fall back to newest" shape as the out_of_scope/dormant picks.
test("GET /v1/designs/scope-match: with more than one flagged design, the one whose scope covers path is named, not just the newest", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  await app.request("/v1/constraints/seed", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({
      projectId: "proj-1",
      constraints: [
        { statement: "protected path A", scope: ["a-protected.ts"], type: "constraint" },
        { statement: "protected path B", scope: ["b-protected.ts"], type: "constraint" },
      ],
    }),
  });

  const olderRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "older", creates: [], touches: ["a-protected.ts"], dependsOn: [], force: true }),
  });
  const { designId: olderId } = (await olderRes.json()) as { designId: string };

  const newerRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "newer", creates: [], touches: ["b-protected.ts"], dependsOn: [], force: true }),
  });
  const { designId: newerId } = (await newerRes.json()) as { designId: string };

  // Asking about the *older* design's file must still name the older
  // design, even though the newer one would win a plain newest-first pick.
  const scopeMatch = await app.request(`/v1/designs/scope-match?projectId=proj-1&sessionId=s1&path=a-protected.ts`, { headers: bearer(admin.token) });
  const body = (await scopeMatch.json()) as { state: string; designId?: string };
  assert.equal(body.state, "flagged");
  assert.equal(body.designId, olderId, "must name the flagged design whose scope actually covers path, not just the newest");
  assert.notEqual(body.designId, newerId);
});

// Same bug class as the out_of_scope newest-first fix above, applied to the
// dormant fallback: `dormantOnes[dormantOnes.length - 1]` picked the oldest
// dormant design, not the most recently parked one.
test("GET /v1/designs/scope-match: dormant fallback picks the newest dormant design, not the oldest", async () => {
  const { app, dataDir, designs } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  const firstRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "oldest task", creates: [], touches: ["a.ts"], dependsOn: [], ttlMs: 10 }),
  });
  const { designId: firstId } = (await firstRes.json()) as { designId: string };

  const secondRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "newest task", creates: [], touches: ["b.ts"], dependsOn: [], ttlMs: 10, force: true }),
  });
  const { designId: secondId } = (await secondRes.json()) as { designId: string };

  designs.sweepExpired(Date.now() + 1000); // both -> dormant

  const scopeMatch = await app.request(`/v1/designs/scope-match?projectId=proj-1&sessionId=s1&path=z.ts`, { headers: bearer(admin.token) });
  const body = (await scopeMatch.json()) as { state: string; designId?: string };
  assert.equal(body.state, "dormant");
  assert.notEqual(body.designId, firstId);
  assert.equal(body.designId, secondId, "must pick the newest dormant design, not the oldest");
});

test("GET /v1/designs/scope-match: a real in_scope hit bumps the design's lastActivityAt", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "", creates: [], touches: ["a.ts"], dependsOn: [] }),
  });
  const before = await app.request(`/v1/designs?projectId=proj-1&sessionId=s1`, { headers: bearer(admin.token) });
  const beforeActivity = ((await before.json()) as { items: { lastActivityAt: number }[] }).items[0].lastActivityAt;

  await new Promise((resolve) => setTimeout(resolve, 5));
  const scopeMatch = await app.request(`/v1/designs/scope-match?projectId=proj-1&sessionId=s1&path=a.ts`, { headers: bearer(admin.token) });
  assert.equal((await scopeMatch.json()).state, "in_scope");

  const after = await app.request(`/v1/designs?projectId=proj-1&sessionId=s1`, { headers: bearer(admin.token) });
  const afterActivity = ((await after.json()) as { items: { lastActivityAt: number }[] }).items[0].lastActivityAt;
  assert.ok(afterActivity > beforeActivity);
});

test("POST /v1/designs/check: a dormant design is excluded from a third design's overlap check (the n² fix)", async () => {
  const { app, dataDir, designs } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "", creates: [], touches: ["shared.ts"], dependsOn: [], ttlMs: 10 }),
  });
  designs.sweepExpired(Date.now() + 1000);

  const secondRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s2", summary: "", creates: [], touches: ["shared.ts"], dependsOn: [] }),
  });
  const secondBody = (await secondRes.json()) as { verdict: string };
  assert.equal(secondBody.verdict, "clean", "a dormant design must not still count as a live conflict");
});

test("POST /v1/designs/:id/resume: a clean resume reassigns sessionId/developerId to a different developer and merges the delta", async () => {
  const { app, dataDir, designs } = freshApp();
  const { alice, bobToken } = await (async () => {
    const admin = await bootstrapAdmin(app, dataDir); // alice
    const registerRes = await app.request("/v1/designs/check", {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(admin.token) },
      body: JSON.stringify({ projectId: "proj-1", sessionId: "s-alice", summary: "alice's paused work", creates: [], touches: ["a.ts"], dependsOn: [], ttlMs: 10 }),
    });
    const { designId } = (await registerRes.json()) as { designId: string };
    const inviteRes = await app.request("/v1/projects/proj-1/invites", {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(admin.token) },
      body: JSON.stringify({ label: "bob@example.com", role: "member" }),
    });
    const invite = (await inviteRes.json()) as { code: string };
    await app.request(`/v1/invites/${invite.code}/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tokenHash: sha256Hex("bobs-pat"), label: "bob@example.com" }),
    });
    return { alice: { token: admin.token, designId }, bobToken: "bobs-pat" };
  })();

  designs.sweepExpired(Date.now() + 1000); // -> dormant

  await withBedrockEnv(() =>
    withMockFetch(
      (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ conflict: false, kind: null, reason: "" }) } }] }), { status: 200 })) as typeof fetch,
      async () => {
        const resumeRes = await app.request(`/v1/designs/${alice.designId}/resume`, {
          method: "POST",
          headers: { "content-type": "application/json", ...bearer(bobToken) },
          body: JSON.stringify({ sessionId: "s-bob", addTouches: ["b.ts"] }),
        });
        assert.deepEqual(await resumeRes.json(), { verdict: "clean", designId: alice.designId });
      },
    ),
  );

  const listRes = await app.request(`/v1/designs?projectId=proj-1&sessionId=s-bob`, { headers: bearer(alice.token) });
  const listBody = (await listRes.json()) as { items: { id: string; status: string; sessionId: string; developerId: string; touches: string[] }[] };
  const resumed = listBody.items.find((d) => d.id === alice.designId);
  assert.equal(resumed?.status, "open");
  assert.equal(resumed?.sessionId, "s-bob");
  assert.equal(resumed?.developerId, "bob@example.com");
  assert.deepEqual(resumed?.touches, ["a.ts", "b.ts"]);
});

test("POST /v1/designs/:id/resume: a conflicting resume persists (identity reassigned, scope merged) and flags, instead of leaving the design untouched", async () => {
  // Found live (2026-08), same gap as amend above: this used to leave the
  // design exactly "dormant" with nothing persisted on a non-clean verdict,
  // so an approved review had nothing to reopen. Fix: `designs.resume`
  // (dormant -> open, identity reassigned, scope merged) runs
  // unconditionally, then `flag` demotes to "flagged" on non-clean.
  const { app, dataDir, designs } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  // A constraint match (tier 3, error severity) on resume, not tier 1 exact
  // overlap -- since the 2026-08-19 severity split, tier 1 alone would
  // leave this resume "open" rather than "flagged" (see the dedicated
  // warning-severity resume test below).
  await app.request("/v1/constraints/seed", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", constraints: [{ statement: "protected path", scope: ["constrained.ts"], type: "constraint" }] }),
  });
  const firstRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "", creates: [], touches: ["a.ts"], dependsOn: [], ttlMs: 10 }),
  });
  const { designId } = (await firstRes.json()) as { designId: string };
  designs.sweepExpired(Date.now() + 1000); // -> dormant

  const resumeRes = await app.request(`/v1/designs/${designId}/resume`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ sessionId: "s1", addTouches: ["constrained.ts"] }),
  });
  const resumeBody = (await resumeRes.json()) as { verdict: string };
  assert.equal(resumeBody.verdict, "constraint_violation");

  // Demoted out of "dormant" into "flagged" -- addressable, not stuck --
  // with the resume's identity reassignment (sessionId) already applied,
  // so a later review approval has something real to reopen.
  const listRes = await app.request(`/v1/designs?projectId=proj-1&sessionId=s1`, { headers: bearer(admin.token) });
  const listBody = (await listRes.json()) as { items: { id: string; status: string; sessionId: string }[] };
  const design = listBody.items.find((d) => d.id === designId);
  assert.equal(design?.status, "flagged");
  assert.equal(design?.sessionId, "s1");
});

// 2026-08-19 severity split: same shape as above, but a warning-severity
// (tier 1) resume must persist and reopen -- no flag, no review needed.
test("POST /v1/designs/:id/resume: a file_overlap (tier 1 exact) resume persists and reopens as 'open'", async () => {
  const { app, dataDir, designs } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);
  // Resume reassigns the design's developerId to whoever calls it (admin,
  // below) -- "s2" needs to belong to someone else, or this is a
  // same-developer pair and no longer produces an overlap verdict at all
  // (2026-08-22).
  const otherPat = await addProjectMember(app, admin.token, "proj-1");

  const firstRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(otherPat) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "unrelated", creates: [], touches: ["shared.ts"], dependsOn: [], ttlMs: 10 }),
  });
  const { designId } = (await firstRes.json()) as { designId: string };
  designs.sweepExpired(Date.now() + 1000); // -> dormant

  await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s2", summary: "also unrelated", creates: [], touches: ["shared.ts"], dependsOn: [] }),
  });

  const resumeRes = await app.request(`/v1/designs/${designId}/resume`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ sessionId: "s1" }),
  });
  const resumeBody = (await resumeRes.json()) as { verdict: string };
  assert.equal(resumeBody.verdict, "file_overlap");

  const listRes = await app.request(`/v1/designs?projectId=proj-1&sessionId=s1`, { headers: bearer(admin.token) });
  const listBody = (await listRes.json()) as { items: { id: string; status: string; sessionId: string }[] };
  const design = listBody.items.find((d) => d.id === designId);
  assert.equal(design?.status, "open", "a file_overlap resume must reopen as 'open', not 'flagged'");

  const activityRes = await app.request(`/v1/activity?projectId=proj-1&relatedId=${designId}`, { headers: bearer(admin.token) });
  const activityBody = (await activityRes.json()) as { items: { kind: string; payload?: { verdict?: string } }[] };
  const checked = activityBody.items.find((e) => e.kind === "design_checked");
  assert.ok(checked, "a file_overlap resume must still log a design_checked event explaining why");
  assert.equal(checked!.payload?.verdict, "file_overlap");
  assert.ok(!activityBody.items.some((e) => e.kind === "design_flagged"), "a file_overlap resume must not also log design_flagged");
  assert.equal(design?.sessionId, "s1");
});

test("POST /v1/designs/check: registering a non-overlapping design for the same session notifies about the stale sibling without changing its status", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  const firstRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "first task", creates: [], touches: ["a.ts"], dependsOn: [] }),
  });
  const { designId: firstId } = (await firstRes.json()) as { designId: string };

  await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "unrelated second task", creates: [], touches: ["b.ts"], dependsOn: [], force: true }),
  });

  const notices = await app.request("/v1/notices?since=0", { headers: bearer(admin.token) });
  const noticesBody = (await notices.json()) as { items: { message: string }[] };
  assert.ok(noticesBody.items.some((n) => n.message.includes(firstId) && n.message.includes("also have design")));

  const listRes = await app.request(`/v1/designs?projectId=proj-1&sessionId=s1`, { headers: bearer(admin.token) });
  const listBody = (await listRes.json()) as { items: { id: string; status: string }[] };
  assert.equal(listBody.items.find((d) => d.id === firstId)?.status, "open", "notify-only -- the sibling's status must not change");
});

test("POST /v1/designs/check: an overlapping second design does not also fire the stale-sibling notice", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "", creates: [], touches: ["a.ts"], dependsOn: [] }),
  });
  await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "", creates: [], touches: ["a.ts"], dependsOn: [], force: true }),
  });

  const notices = await app.request("/v1/notices?since=0", { headers: bearer(admin.token) });
  const noticesBody = (await notices.json()) as { items: { message: string }[] };
  assert.equal(
    noticesBody.items.filter((n) => n.message.includes("also have design")).length,
    0,
    "already caught by the real overlap/flagged path -- no double-signal",
  );
});

// "Force a choice" registration-sprawl fix (2026-08-25): the stale-sibling
// nudge's sibling set was broadened from same-session to
// openDesignsForDeveloper -- see app.ts's own comment on the exact spot.
// This test previously asserted the opposite (cross-session siblings don't
// fire); it now pins the new, intended behavior instead.
test("POST /v1/designs/check: a non-overlapping design from a *different* session DOES now fire a stale-sibling notice (broadened, 2026-08-25)", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  const firstRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "", creates: [], touches: ["a.ts"], dependsOn: [] }),
  });
  const { designId: firstId } = (await firstRes.json()) as { designId: string };
  await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s2", summary: "", creates: [], touches: ["b.ts"], dependsOn: [], force: true }),
  });

  const notices = await app.request("/v1/notices?since=0", { headers: bearer(admin.token) });
  const noticesBody = (await notices.json()) as { items: { message: string }[] };
  assert.ok(
    noticesBody.items.some((n) => n.message.includes(firstId) && n.message.includes("also have design")),
    "the nudge is developer-wide now, not scoped to same-session siblings",
  );
});

test("GET /v1/designs/scope-match: an open design takes precedence over a dormant one when both cover the same path", async () => {
  const { app, dataDir, designs } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  const dormantRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "", creates: [], touches: ["a.ts"], dependsOn: [], ttlMs: 10 }),
  });
  const { designId: dormantId } = (await dormantRes.json()) as { designId: string };
  designs.sweepExpired(Date.now() + 1000); // -> dormant

  // Registering again in the same session, also touching a.ts, is clean --
  // the dormant sibling is excluded from openDesigns()'s conflict feed.
  const openRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "", creates: [], touches: ["a.ts"], dependsOn: [] }),
  });
  const { designId: openId, verdict } = (await openRes.json()) as { designId: string; verdict: string };
  assert.equal(verdict, "clean");
  assert.notEqual(openId, dormantId);

  const scopeMatch = await app.request(`/v1/designs/scope-match?projectId=proj-1&sessionId=s1&path=a.ts`, { headers: bearer(admin.token) });
  const body = (await scopeMatch.json()) as { state: string; designId?: string };
  assert.equal(body.state, "in_scope");
  assert.equal(body.designId, openId, "the open design must win, not the dormant one");
});

test("GET /v1/designs/scope-match: dormant state still fires even when path doesn't match the dormant design's own scope", async () => {
  const { app, dataDir, designs } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  const registerRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "", creates: [], touches: ["a.ts"], dependsOn: [], ttlMs: 10 }),
  });
  const { designId } = (await registerRes.json()) as { designId: string };
  designs.sweepExpired(Date.now() + 1000);

  const scopeMatch = await app.request(`/v1/designs/scope-match?projectId=proj-1&sessionId=s1&path=totally-unrelated.ts`, { headers: bearer(admin.token) });
  const body = (await scopeMatch.json()) as { state: string; designId?: string };
  assert.equal(body.state, "dormant", "unlike out_of_scope, a dormant nudge doesn't require the path to actually match");
  assert.equal(body.designId, designId);
});

// --- ExitPlanMode retry dedup (§17, 2026-08-18) ---
// hook/design_gate.go's handleExitPlanMode has no client-side memory of a
// prior registration and resends rawPlanText fresh on every retry; these
// tests exercise the server-side dedup that fixes the resulting unbounded
// duplicate-registration loop. Every case here sends `rawPlanText` *and*
// structured fields together so `hasStructured` is true and the LLM
// extraction branch is skipped (matching every other /v1/designs/check test
// in this file) -- `rawPlanText`'s presence alone is what drives the dedup
// lookup/Jaccard gate, independent of where creates/touches/summary come
// from.

test("POST /v1/designs/check: a near-identical rawPlanText retry for the same session reregisters in place instead of duplicating", async () => {
  const { app, dataDir, designs } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);
  const planText = "Add a RetryPolicy class to src/net/retry.ts implementing exponential backoff with jitter for outbound HTTP calls.";

  const first = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s-plan", rawPlanText: planText, summary: "add retry policy", creates: [], touches: ["src/net/retry.ts"], dependsOn: [] }),
  });
  const firstBody = (await first.json()) as { designId: string; verdict: string };
  assert.equal(first.status, 200);
  assert.equal(firstBody.verdict, "clean");

  // A retry: same plan text, byte-identical -- the easy case.
  const second = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s-plan", rawPlanText: planText, summary: "add retry policy", creates: [], touches: ["src/net/retry.ts"], dependsOn: [] }),
  });
  const secondBody = (await second.json()) as { designId: string; verdict: string };
  assert.equal(second.status, 200);
  assert.equal(secondBody.verdict, "clean", "reregistering in place must not overlap itself");
  assert.equal(secondBody.designId, firstBody.designId, "same row updated, not a new one");
  assert.equal(designs.get(firstBody.designId)?.scopeVersion, 2, "reregisterFromPlan bumps scopeVersion same as amend/resume");

  // Exactly one live design for this session/project, not two.
  assert.equal(designs.openDesigns("proj-1").length, 1);
});

test("POST /v1/designs/check: a substantively different rawPlanText for the same session registers a new row and leaves the candidate untouched", async () => {
  const { app, dataDir, designs } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  const first = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({
      projectId: "proj-1",
      sessionId: "s-plan",
      rawPlanText: "Add a RetryPolicy class to src/net/retry.ts implementing exponential backoff with jitter for outbound HTTP calls, depending on the existing Clock abstraction.",
      summary: "add retry policy",
      creates: [],
      touches: ["src/net/retry.ts"],
      dependsOn: [],
    }),
  });
  const firstBody = (await first.json()) as { designId: string };

  // A genuinely different plan (per the module's own jaccard test fixture --
  // shares "existing Clock abstraction" vocabulary but is otherwise
  // unrelated), same session id, later in the same conversation.
  const second = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({
      projectId: "proj-1",
      sessionId: "s-plan",
      rawPlanText: "Add a debounce helper to src/ui/search-box.ts so keystrokes don't trigger a network call on every character, using the existing Clock abstraction for timing.",
      summary: "add debounce helper",
      creates: [],
      touches: ["src/ui/search-box.ts"],
      dependsOn: [],
    }),
  });
  const secondBody = (await second.json()) as { designId: string; verdict: string };
  assert.equal(second.status, 200);
  assert.notEqual(secondBody.designId, firstBody.designId, "a genuinely different plan must get its own row");

  const first_ = designs.get(firstBody.designId);
  assert.equal(first_?.scopeVersion, 1, "the earlier candidate must be left completely untouched");
  assert.deepEqual(first_?.touches, ["src/net/retry.ts"]);
});

test("POST /v1/designs/check: a rawPlanText registration under a *different* session id never reregisters another session's design", async () => {
  const { app, dataDir, designs } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);
  const otherPat = await addProjectMember(app, admin.token, "proj-1"); // same-developer pairs no longer produce an overlap verdict at all (2026-08-22)
  const planText = "Add a RetryPolicy class to src/net/retry.ts implementing exponential backoff with jitter for outbound HTTP calls.";

  const first = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s-one", rawPlanText: planText, summary: "add retry policy", creates: [], touches: ["src/net/retry.ts"], dependsOn: [] }),
  });
  const firstBody = (await first.json()) as { designId: string };

  const second = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(otherPat) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s-two", rawPlanText: planText, summary: "add retry policy", creates: [], touches: ["src/net/retry.ts"], dependsOn: [] }),
  });
  const secondBody = (await second.json()) as { designId: string; verdict: string };
  assert.equal(second.status, 200);
  assert.notEqual(secondBody.designId, firstBody.designId, "a different session must not reregister another session's design");
  assert.equal(secondBody.verdict, "file_overlap", "and correctly conflicts with it, same as any other pair of unrelated open designs");
});

test("POST /v1/designs/check: a structured (twing design register-style) call with no rawPlanText always creates a new row, even repeated in the same session", async () => {
  const { app, dataDir, designs } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  const first = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s-cli", summary: "task one", creates: ["A"], touches: [], dependsOn: [] }),
  });
  const firstBody = (await first.json()) as { designId: string };

  const second = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s-cli", summary: "task one", creates: ["A"], touches: [], dependsOn: [], force: true }),
  });
  const secondBody = (await second.json()) as { designId: string; verdict: string };
  assert.equal(second.status, 200);
  assert.notEqual(secondBody.designId, firstBody.designId, "structured register calls are never deduped -- only ExitPlanMode's rawPlanText path is");
  // Both registered by the same developer (same session, even) -- same-
  // developer pairs no longer produce an overlap verdict at all
  // (2026-08-22). The real thing this test pins -- a genuinely new row, not
  // a dedup -- is the assertion above; the verdict itself is incidental.
  assert.equal(secondBody.verdict, "clean");
});

test("POST /v1/designs/check: a reregistered design keeps its justifiedConstraintIds -- an approved review survives the retry", async () => {
  const { app, dataDir, designs, constraints } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);
  constraints.add("proj-1", "review required for retry.ts", ["src/net/retry.ts"], "constraint", "seeded");
  const planText = "Add a RetryPolicy class to src/net/retry.ts implementing exponential backoff with jitter for outbound HTTP calls.";

  const first = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s-plan", rawPlanText: planText, summary: "add retry policy", creates: [], touches: ["src/net/retry.ts"], dependsOn: [] }),
  });
  const firstBody = (await first.json()) as { designId: string; verdict: string };
  assert.equal(firstBody.verdict, "constraint_violation");

  const resolveRes = await app.request(`/v1/designs/${firstBody.designId}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ resolution: "justified_divergence", justification: "reviewed, fine" }),
  });
  const { reviewId } = (await resolveRes.json()) as { reviewId: string };
  const decideRes = await app.request(`/v1/reviews/${reviewId}/decide`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ decision: "approve" }),
  });
  assert.equal(decideRes.status, 200, await decideRes.text());
  assert.ok(designs.get(firstBody.designId)?.justifiedConstraintIds.length, "sanity: the approval populated justifiedConstraintIds before the retry");

  // Retry: same plan text -- reregisters in place rather than duplicating.
  const second = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s-plan", rawPlanText: planText, summary: "add retry policy", creates: [], touches: ["src/net/retry.ts"], dependsOn: [] }),
  });
  const secondBody = (await second.json()) as { designId: string; verdict: string };
  assert.equal(secondBody.designId, firstBody.designId, "same row reregistered");
  assert.equal(secondBody.verdict, "clean", "already-justified constraint must not be re-flagged after a mere retry");
});

// ---------------------------------------------------------------------------
// "Force a choice" registration-sprawl fix (2026-08-25) -- POST
// /v1/designs/check's pre-registration has_open_designs check.
// ---------------------------------------------------------------------------

test("POST /v1/designs/check: a structured register call blocks with has_open_designs when the developer already has another open design, and creates no row", async () => {
  const { app, dataDir, designs } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  const firstRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "first", creates: [], touches: ["a.ts"], dependsOn: [] }),
  });
  const { designId: firstId } = (await firstRes.json()) as { designId: string };

  const beforeCount = designs.listByProject("proj-1").length;
  const secondRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-2", sessionId: "s2", summary: "second, different project entirely", creates: [], touches: ["b.ts"], dependsOn: [] }),
  });
  assert.equal(secondRes.status, 200);
  const secondBody = (await secondRes.json()) as { verdict: string; designId?: string; openDesigns?: { id: string }[] };
  assert.equal(secondBody.verdict, "has_open_designs");
  assert.equal(secondBody.designId, undefined, "no row exists for this verdict yet");
  assert.ok(secondBody.openDesigns?.some((d) => d.id === firstId));
  assert.equal(designs.listByProject("proj-1").length, beforeCount, "no new row persisted anywhere");
  assert.equal(designs.listByProject("proj-2").length, 0, "no new row persisted anywhere");
});

test("POST /v1/designs/check: a caller-supplied groupId skips the has_open_designs block", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  const firstRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "first", creates: [], touches: ["a.ts"], dependsOn: [] }),
  });
  const { designId: firstId } = (await firstRes.json()) as { designId: string };

  const secondRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-2", sessionId: "s2", summary: "linked continuation", creates: [], touches: ["b.ts"], dependsOn: [], groupId: firstId }),
  });
  const secondBody = (await secondRes.json()) as { verdict: string; groupId?: string };
  assert.notEqual(secondBody.verdict, "has_open_designs");
  assert.equal(secondBody.groupId, firstId);
});

test("POST /v1/designs/check: force:true skips the has_open_designs block", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "first", creates: [], touches: ["a.ts"], dependsOn: [] }),
  });

  const secondRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-2", sessionId: "s2", summary: "genuinely new", creates: [], touches: ["b.ts"], dependsOn: [], force: true }),
  });
  const secondBody = (await secondRes.json()) as { verdict: string; designId?: string };
  assert.notEqual(secondBody.verdict, "has_open_designs");
  assert.ok(secondBody.designId);
});

test("POST /v1/designs/check: an ExitPlanMode-shaped (rawPlanText) request is never blocked by has_open_designs, regardless of other open designs", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "first", creates: [], touches: ["a.ts"], dependsOn: [] }),
  });

  const secondRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({
      projectId: "proj-2",
      sessionId: "s-plan",
      rawPlanText: "Add a debounce helper to src/ui/search-box.ts so keystrokes don't trigger a network call on every character.",
      summary: "add debounce helper",
      creates: [],
      touches: ["src/ui/search-box.ts"],
      dependsOn: [],
    }),
  });
  assert.equal(secondRes.status, 200);
  const secondBody = (await secondRes.json()) as { verdict: string; designId?: string };
  assert.notEqual(secondBody.verdict, "has_open_designs");
  assert.ok(secondBody.designId);
});

// --- §17 Phase 4: no_auth mode ---

function freshNoAuthApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "twing-app-test-"));
  const db = createDb({ memory: true });
  const identities = new IdentityStore(db, { dataDir });
  const store = new Store(db);
  const designs = new DesignRegistry(db);
  const constraints = new ConstraintStore(db);
  const alignmentThreads = new AlignmentThreadStore(db);
  const app = createApp({ db, identities, store, designs, constraints, alignmentThreads, noAuth: true });
  return { app, dataDir, identities, store, designs, constraints, alignmentThreads };
}

function developerHeader(id: string) {
  return { "x-twing-developer-id": id };
}

test("no_auth mode: a write with no bearer token and no developer-id header is rejected with 400", async () => {
  const { app } = freshNoAuthApp();
  const res = await app.request("/v1/claims", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: "p1", claims: [] }),
  });
  assert.equal(res.status, 400, "a no_auth server must never fall back to a silent anonymous identity");
});

test("no_auth mode: a write with a self-declared X-Twing-Developer-Id header succeeds with no bearer token at all", async () => {
  const { app } = freshNoAuthApp();
  const res = await app.request("/v1/claims", {
    method: "POST",
    headers: { "content-type": "application/json", ...developerHeader("bob@example.com") },
    body: JSON.stringify({ projectId: "p1", claims: [] }),
  });
  assert.equal(res.status, 200);
});

test("no_auth mode: role-gated routes (review decide) succeed regardless of \"role\" -- no admin/membership check applies", async () => {
  const { app } = freshNoAuthApp();
  const dev = developerHeader("carol@example.com");

  // Register a design, then flag it via a seeded constraint so there's a
  // real pending review to decide -- same setup shape the full-auth
  // review-decide tests use elsewhere in this file, just with the
  // X-Twing-Developer-Id header instead of a bearer token throughout.
  const seedRes = await app.request("/v1/constraints/seed", {
    method: "POST",
    headers: { "content-type": "application/json", ...dev },
    body: JSON.stringify({ projectId: "proj-1", constraints: [{ statement: "needs review", scope: ["a.ts"], type: "constraint" }] }),
  });
  assert.equal(seedRes.status, 200);

  const checkRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...dev },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "", creates: [], touches: ["a.ts"], dependsOn: [] }),
  });
  const { designId, verdict } = (await checkRes.json()) as { designId: string; verdict: string };
  assert.equal(verdict, "constraint_violation");

  const resolveRes = await app.request(`/v1/designs/${designId}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", ...dev },
    body: JSON.stringify({ resolution: "justified_divergence", justification: "testing no_auth review-decide" }),
  });
  const { reviewId } = (await resolveRes.json()) as { reviewId: string };

  // No admin/membership of any kind was ever established for "carol" above
  // (no_auth has no role tiers at all) -- this must still succeed.
  const decideRes = await app.request(`/v1/reviews/${reviewId}/decide`, {
    method: "POST",
    headers: { "content-type": "application/json", ...dev },
    body: JSON.stringify({ decision: "approve" }),
  });
  assert.equal(decideRes.status, 200, "no_auth must not require project-admin role for review decisions");
});

// --- §17 Phase 3: GitHub-verified project join ---

function mockGithubRepoResponse(permissions: Record<string, boolean>): typeof fetch {
  return (async (url: string | URL | Request) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (href === "https://api.github.com/repos/acme/widgets") {
      return new Response(JSON.stringify({ permissions }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
  }) as typeof fetch;
}

test("POST /v1/projects/:id/join-via-github: pull/triage/push permissions grant member, unauthenticated with a fresh token", async () => {
  const { app, dataDir, identities } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);
  identities.foundProject("proj-1", admin.developerId, { owner: "acme", repo: "widgets" });

  await withMockFetch(mockGithubRepoResponse({ pull: true, triage: true, push: true, maintain: false, admin: false }), async () => {
    const res = await app.request("/v1/projects/proj-1/join-via-github", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ githubToken: "gh-token-bob", tokenHash: sha256Hex("bobs-pat"), label: "bob@example.com" }),
    });
    const body = (await res.json()) as { developerId?: string; role?: string; error?: string };
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.developerId, "bob@example.com");
    assert.equal(body.role, "member");
    assert.equal(identities.getProjectRole("proj-1", "bob@example.com"), "member");
  });
});

test("POST /v1/projects/:id/join-via-github: maintain permission grants admin", async () => {
  const { app, dataDir, identities } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);
  identities.foundProject("proj-1", admin.developerId, { owner: "acme", repo: "widgets" });

  await withMockFetch(mockGithubRepoResponse({ pull: true, triage: true, push: true, maintain: true, admin: false }), async () => {
    const res = await app.request("/v1/projects/proj-1/join-via-github", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ githubToken: "gh-token-carol", tokenHash: sha256Hex("carols-pat"), label: "carol@example.com" }),
    });
    const body = (await res.json()) as { role?: string };
    assert.equal(res.status, 200);
    assert.equal(body.role, "admin");
  });
});

test("POST /v1/projects/:id/join-via-github: admin permission also grants admin", async () => {
  const { app, dataDir, identities } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);
  identities.foundProject("proj-1", admin.developerId, { owner: "acme", repo: "widgets" });

  await withMockFetch(mockGithubRepoResponse({ pull: true, triage: true, push: true, maintain: false, admin: true }), async () => {
    const res = await app.request("/v1/projects/proj-1/join-via-github", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ githubToken: "gh-token-dave", tokenHash: sha256Hex("daves-pat"), label: "dave@example.com" }),
    });
    const body = (await res.json()) as { role?: string };
    assert.equal(res.status, 200);
    assert.equal(body.role, "admin");
  });
});

test("POST /v1/projects/:id/join-via-github: no repo access (GitHub 404) is rejected", async () => {
  const { app, dataDir, identities } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);
  identities.foundProject("proj-1", admin.developerId, { owner: "acme", repo: "widgets" });

  await withMockFetch(
    (async () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })) as typeof fetch,
    async () => {
      const res = await app.request("/v1/projects/proj-1/join-via-github", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ githubToken: "gh-token-eve", tokenHash: sha256Hex("eves-pat"), label: "eve@example.com" }),
      });
      assert.equal(res.status, 403);
      assert.equal(identities.getProjectRole("proj-1", "eve@example.com"), undefined);
    },
  );
});

test("POST /v1/projects/:id/join-via-github: a project with no GitHub binding 404s without ever calling GitHub", async () => {
  const { app, dataDir, identities } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);
  identities.foundProject("proj-1", admin.developerId); // no github binding

  await withMockFetch(
    (async () => {
      throw new Error("must not call GitHub for a project with no binding");
    }) as typeof fetch,
    async () => {
      const res = await app.request("/v1/projects/proj-1/join-via-github", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ githubToken: "gh-token-frank", tokenHash: sha256Hex("franks-pat"), label: "frank@example.com" }),
      });
      assert.equal(res.status, 404);
    },
  );
});

test("POST /v1/projects/:id/join-via-github: already-authenticated developer attaches to their existing identity, no tokenHash/label needed", async () => {
  const { app, dataDir, identities } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);
  identities.foundProject("proj-1", admin.developerId, { owner: "acme", repo: "widgets" });

  // Gives grace a real, resolvable PAT and an *org* membership only --
  // deliberately not proj-1 membership, so the assertion below actually
  // proves the route grants it, not that she already had it.
  const graceToken = "graces-pat";
  const orgInvite = identities.createInvite({ kind: "org", orgId: admin.orgId }, "member", "grace@example.com", admin.developerId);
  identities.redeemInvite(orgInvite.code, { tokenHash: sha256Hex(graceToken), label: "grace@example.com" });

  await withMockFetch(mockGithubRepoResponse({ pull: true, triage: false, push: false, maintain: false, admin: false }), async () => {
    const res = await app.request("/v1/projects/proj-1/join-via-github", {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(graceToken) },
      body: JSON.stringify({ githubToken: "gh-token-grace" }),
    });
    const body = (await res.json()) as { developerId?: string; role?: string; error?: string };
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.developerId, "grace@example.com");
    assert.equal(identities.getProjectRole("proj-1", "grace@example.com"), "member");
  });
});

// --- §17 Phase 3 GitHub-founding (2026-08-17): `twing init`'s default
// path -- founding a project with no org at all, gated purely on real
// GitHub admin/maintain access, no invite/admin-bootstrap in the loop. ---

test("POST /v1/projects/:id/join-via-github: admin permission on an unfounded project founds it, no org, caller becomes project admin", async () => {
  const { app, identities } = freshApp();

  await withMockFetch(mockGithubRepoResponse({ pull: true, triage: true, push: true, maintain: false, admin: true }), async () => {
    const res = await app.request("/v1/projects/proj-fresh/join-via-github", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ githubToken: "gh-token-alice", githubOwner: "acme", githubRepo: "widgets", tokenHash: sha256Hex("alices-pat"), label: "alice@example.com" }),
    });
    const body = (await res.json()) as { developerId?: string; role?: string; founded?: boolean; error?: string };
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.developerId, "alice@example.com");
    assert.equal(body.role, "admin");
    assert.equal(body.founded, true);
    assert.equal(identities.getProjectRole("proj-fresh", "alice@example.com"), "admin");
    assert.equal(identities.getProjectRecord("proj-fresh")?.orgId, undefined, "GitHub-founded project has no org at all");
    assert.deepEqual(identities.getProjectRecord("proj-fresh")?.githubOwner, "acme");
  });
});

test("POST /v1/projects/:id/join-via-github: maintain permission also founds an unfounded project", async () => {
  const { app, identities } = freshApp();

  await withMockFetch(mockGithubRepoResponse({ pull: true, triage: true, push: true, maintain: true, admin: false }), async () => {
    const res = await app.request("/v1/projects/proj-fresh/join-via-github", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ githubToken: "gh-token-alice", githubOwner: "acme", githubRepo: "widgets", tokenHash: sha256Hex("alices-pat"), label: "alice@example.com" }),
    });
    assert.equal(res.status, 200);
    assert.equal(identities.getProjectRole("proj-fresh", "alice@example.com"), "admin");
  });
});

test("POST /v1/projects/:id/join-via-github: pull-only access cannot found an unfounded project", async () => {
  const { app, identities } = freshApp();

  await withMockFetch(mockGithubRepoResponse({ pull: true, triage: false, push: false, maintain: false, admin: false }), async () => {
    const res = await app.request("/v1/projects/proj-fresh/join-via-github", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ githubToken: "gh-token-bob", githubOwner: "acme", githubRepo: "widgets", tokenHash: sha256Hex("bobs-pat"), label: "bob@example.com" }),
    });
    const body = (await res.json()) as { error?: string };
    assert.equal(res.status, 403, JSON.stringify(body));
    assert.ok(/admin\/maintain/.test(body.error ?? ""));
    assert.equal(identities.isProjectFounded("proj-fresh"), false, "must not have founded the project");
  });
});

test("POST /v1/projects/:id/join-via-github: an unfounded project with no githubOwner/githubRepo in the body 400s before ever calling GitHub", async () => {
  const { app } = freshApp();

  await withMockFetch(
    (async () => {
      throw new Error("must not call GitHub without owner/repo to check");
    }) as typeof fetch,
    async () => {
      const res = await app.request("/v1/projects/proj-fresh/join-via-github", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ githubToken: "gh-token-bob", tokenHash: sha256Hex("bobs-pat"), label: "bob@example.com" }),
      });
      assert.equal(res.status, 400);
    },
  );
});

test("POST /v1/projects/:id/join-via-github: an already-founded project ignores a client-claimed githubOwner/githubRepo, checks permissions against the stored binding", async () => {
  const { app, dataDir, identities } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);
  identities.foundProject("proj-1", admin.developerId, { owner: "acme", repo: "widgets" });

  let calledUrl: string | undefined;
  const fetchSpy = (async (url: string | URL | Request) => {
    calledUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    return new Response(JSON.stringify({ permissions: { pull: true, triage: true, push: true, maintain: false, admin: false } }), { status: 200 });
  }) as typeof fetch;

  await withMockFetch(fetchSpy, async () => {
    const res = await app.request("/v1/projects/proj-1/join-via-github", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Claims a *different* repo than what proj-1 is actually bound to --
      // must be ignored, not trusted, for the permission check.
      body: JSON.stringify({ githubToken: "gh-token-mallory", githubOwner: "someone-elses-org", githubRepo: "unrelated-repo", tokenHash: sha256Hex("mallorys-pat"), label: "mallory@example.com" }),
    });
    assert.equal(res.status, 200);
    assert.equal(calledUrl, "https://api.github.com/repos/acme/widgets", "must check permissions against the stored binding, never a client claim");
  });
});

test("POST /v1/projects/:id/join-via-github: an already-cached token's role is re-checked (refreshed) on every join, not just the first", async () => {
  const { app, dataDir, identities } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);
  identities.foundProject("proj-1", admin.developerId, { owner: "acme", repo: "widgets" });

  const graceToken = "graces-pat";
  const orgInvite = identities.createInvite({ kind: "org", orgId: admin.orgId }, "member", "grace@example.com", admin.developerId);
  identities.redeemInvite(orgInvite.code, { tokenHash: sha256Hex(graceToken), label: "grace@example.com" });

  await withMockFetch(mockGithubRepoResponse({ pull: true, triage: false, push: false, maintain: false, admin: false }), async () => {
    await app.request("/v1/projects/proj-1/join-via-github", {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(graceToken) },
      body: JSON.stringify({ githubToken: "gh-token-grace" }),
    });
  });
  assert.equal(identities.getProjectRole("proj-1", "grace@example.com"), "member");

  // Grace was promoted to maintain on GitHub's side since -- re-running the
  // same join call must pick that up, not leave her stuck at the role from
  // her first join.
  await withMockFetch(mockGithubRepoResponse({ pull: true, triage: true, push: true, maintain: true, admin: false }), async () => {
    const res = await app.request("/v1/projects/proj-1/join-via-github", {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(graceToken) },
      body: JSON.stringify({ githubToken: "gh-token-grace" }),
    });
    const body = (await res.json()) as { role?: string };
    assert.equal(res.status, 200);
    assert.equal(body.role, "admin");
  });
  assert.equal(identities.getProjectRole("proj-1", "grace@example.com"), "admin");
});

// POST /v1/designs/extract -- the multi-repo ExitPlanMode fallback's
// extraction-only endpoint (2026-08-18 fix, hook/design_gate.go's
// handleExitPlanModeMultiCandidate). No projectId, no registration: just
// runs extractDesign() and hands back the structured result so the hook
// can decide which candidate repo(s) a plan actually belongs to before
// ever calling /v1/designs/check.
function mockBedrockExtraction(extracted: { creates: string[]; touches: string[]; dependsOn: string[]; summary: string }): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(extracted) } }] }), { status: 200 })) as typeof fetch;
}

test("POST /v1/designs/extract: returns the structured extraction with no project and no registration side effects", async () => {
  const { app, dataDir, designs } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  const extracted = {
    creates: [],
    touches: ["TwingMail/packages/api/mailbox.ts", "twinmail-ui/src/Inbox.tsx"],
    dependsOn: [],
    summary: "fix mailbox parsing and its UI display",
  };

  const res = await withBedrockEnv(() =>
    withMockFetch(mockBedrockExtraction(extracted), async () =>
      app.request("/v1/designs/extract", {
        method: "POST",
        headers: { "content-type": "application/json", ...bearer(admin.token) },
        body: JSON.stringify({ rawPlanText: "Fix mailbox parsing in the backend and its display in the UI." }),
      }),
    ),
  );
  const body = (await res.json()) as { creates: string[]; touches: string[]; dependsOn: string[]; summary: string };
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.deepEqual(body.touches, extracted.touches);
  assert.equal(body.summary, extracted.summary);

  // No project was ever named, so nothing should have registered anywhere.
  assert.equal(designs.openDesigns("proj-1", Date.now()).length, 0);
});

test("POST /v1/designs/extract: rejects a request with no rawPlanText", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  const res = await app.request("/v1/designs/extract", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

test("POST /v1/designs/extract: still requires authentication, same as every other /v1/* route", async () => {
  const { app } = freshApp();

  const res = await app.request("/v1/designs/extract", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rawPlanText: "do the thing" }),
  });
  assert.equal(res.status, 401);
});

test("GET /v1/version: unauthenticated, reports the configured version", async () => {
  const { app } = freshApp({ version: "9.9.9" });

  const res = await app.request("/v1/version");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { version: string };
  assert.equal(body.version, "9.9.9");
});

test("hook version-mismatch: a mismatched x-twing-hook-version denies with 426 before the auth check ever runs", async () => {
  const { app } = freshApp({ version: "9.9.9" });

  // No Authorization header at all -- would otherwise be a 401. The 426
  // must win, since a stale hook binary needs to know *why* even when its
  // cached token would also be rejected.
  const res = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", "x-twing-hook-version": "0.0.1" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 426);
  const body = (await res.json()) as { error: string; hookVersion: string; serverVersion: string };
  assert.equal(body.error, "hook_version_mismatch");
  assert.equal(body.hookVersion, "0.0.1");
  assert.equal(body.serverVersion, "9.9.9");
});

test("hook version-mismatch: a matching x-twing-hook-version falls through to the normal (401) path", async () => {
  const { app } = freshApp({ version: "9.9.9" });

  const res = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", "x-twing-hook-version": "9.9.9" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 401);
});

test("hook version-mismatch: no x-twing-hook-version header at all falls through normally (401), not 426 -- these routes aren't hook-exclusive", async () => {
  const { app } = freshApp({ version: "9.9.9" });

  // /v1/designs/check is called directly by the TS CLI's own design.ts
  // commands too, not just the Go hook -- they never send this header
  // either, so a missing header here must never be treated as "must be an
  // old hook binary, deny it" (attempted and reverted, see app.ts's
  // comment on this middleware).
  const res = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 401);
});

// Public "observe twing getting built" demo (2026-08-28, generalized from a
// single project to a list the same day) -- see app.ts's publicProjectIds
// doc comment on the auth middleware for the mechanism this exercises: an
// unauthenticated GET is synthesized into an identity that's a member of
// every project in publicProjectIds, reusing isProjectMember's existing
// check for isolation rather than any new authorization logic.
test("GET /v1/designs: an unauthenticated request succeeds and returns data when publicProjectIds is set, scoped to that project", async () => {
  const { app, dataDir } = freshApp({ publicProjectIds: ["proj-1"] });
  const admin = await bootstrapAdmin(app, dataDir);
  await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "public demo project's own real work", creates: [], touches: ["src/x.ts"], dependsOn: [] }),
  });

  const res = await app.request("/v1/designs?projectId=proj-1");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { items: { summary: string }[] };
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].summary, "public demo project's own real work");
});

test("GET /v1/designs: an unauthenticated request against any project other than one in publicProjectIds still 403s -- isolation comes from the same isProjectMember check every route already has, not new logic", async () => {
  const { app, dataDir } = freshApp({ publicProjectIds: ["proj-1"] });
  await bootstrapAdmin(app, dataDir); // founds proj-1

  const res = await app.request("/v1/designs?projectId=some-other-real-tenants-project");
  assert.equal(res.status, 403);
});

test("GET /v1/designs: an unauthenticated request succeeds for every project listed in publicProjectIds, not just the first", async () => {
  const { app, dataDir, identities } = freshApp({ publicProjectIds: ["proj-1", "proj-2"] });
  const admin = await bootstrapAdmin(app, dataDir); // founds proj-1
  identities.foundProject("proj-2", admin.developerId, { owner: "acme", repo: "widgets-2" });

  const res1 = await app.request("/v1/designs?projectId=proj-1");
  assert.equal(res1.status, 200);
  const res2 = await app.request("/v1/designs?projectId=proj-2");
  assert.equal(res2.status, 200);
});

test("GET /v1/reviews: 404s for the unauthenticated public viewer, never the real (possibly candid) review data", async () => {
  const { app, dataDir } = freshApp({ publicProjectIds: ["proj-1"] });
  await bootstrapAdmin(app, dataDir);

  const res = await app.request("/v1/reviews?projectId=proj-1");
  assert.equal(res.status, 404);
});

test("an unauthenticated POST/PATCH still 401s exactly as before, even with publicProjectIds set -- the synthetic identity is only ever built for GET", async () => {
  const { app, dataDir } = freshApp({ publicProjectIds: ["proj-1"] });
  await bootstrapAdmin(app, dataDir);

  const postRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "", creates: [], touches: [], dependsOn: [] }),
  });
  assert.equal(postRes.status, 401);

  const patchRes = await app.request("/v1/designs/some-id/close", { method: "PATCH" });
  assert.equal(patchRes.status, 401);
});

test("GET /v1/designs: an unauthenticated request 401s exactly as before when publicProjectIds is unset -- zero behavior change for every other deployment", async () => {
  const { app, dataDir } = freshApp(); // no publicProjectIds
  await bootstrapAdmin(app, dataDir);

  const res = await app.request("/v1/designs?projectId=proj-1");
  assert.equal(res.status, 401);
});
