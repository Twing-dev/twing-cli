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

function freshApp() {
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
  const app = createApp({ db, identities, store, designs, constraints, alignmentThreads });
  return { app, dataDir, identities, store, designs, alignmentThreads };
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

  // alice founds proj-1 via a design registration, then creates a second, conflicting design and justifies the divergence.
  const check1 = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "first", creates: ["a.ts"], touches: [], dependsOn: [] }),
  });
  assert.equal(check1.status, 200);

  const check2 = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s2", summary: "second, overlapping", creates: ["a.ts"], touches: [], dependsOn: [] }),
  });
  assert.equal(check2.status, 200);
  const check2Body = (await check2.json()) as { verdict: string; designId: string };
  assert.equal(check2Body.verdict, "overlap");

  const resolveRes = await app.request(`/v1/designs/${check2Body.designId}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
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
    items: { developerId: string; otherDeveloperId: string; systemDescription: string }[];
  };
  assert.equal(threadsBody.items.length, 1);
  assert.equal(threadsBody.items[0].developerId, "bob@example.com");
  assert.equal(threadsBody.items[0].otherDeveloperId, "alice@example.com");
  assert.equal(threadsBody.items[0].systemDescription, "they fight over the same guarantee");

  const aliceNotices = await app.request("/v1/notices?since=0", { headers: bearer(admin.token) });
  const aliceNoticesBody = (await aliceNotices.json()) as { items: { message: string }[] };
  assert.ok(aliceNoticesBody.items.some((n) => n.message === "they fight over the same guarantee"));

  const bobNotices = await app.request("/v1/notices?since=0", { headers: bearer("bobs-pat") });
  const bobNoticesBody = (await bobNotices.json()) as { items: { message: string }[] };
  assert.ok(bobNoticesBody.items.some((n) => n.message === "they fight over the same guarantee"));
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

// --- §17 scope enforcement (2026-08): flag / scope-match / amend ---

test("POST /v1/designs/check: an overlap verdict persists as status 'flagged', not 'open' (§17 scope enforcement)", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "first", creates: ["a.ts"], touches: [], dependsOn: [] }),
  });
  const overlapRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s2", summary: "second, overlapping", creates: ["a.ts"], touches: [], dependsOn: [] }),
  });
  const overlapBody = (await overlapRes.json()) as { verdict: string; designId: string };
  assert.equal(overlapBody.verdict, "overlap");

  const listRes = await app.request(`/v1/designs?projectId=proj-1&sessionId=s2`, { headers: bearer(admin.token) });
  const listBody = (await listRes.json()) as { items: { id: string; status: string }[] };
  const registered = listBody.items.find((d) => d.id === overlapBody.designId);
  assert.equal(registered?.status, "flagged", "a design whose own verdict wasn't clean must not read back as 'open'");
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
  assert.deepEqual(await outOfScope.json(), { state: "out_of_scope", designId });

  const flaggedRegisterRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s2", summary: "", creates: [], touches: ["a.ts"], dependsOn: [] }),
  });
  const { designId: flaggedId, verdict: flaggedVerdict } = (await flaggedRegisterRes.json()) as { designId: string; verdict: string };
  assert.equal(flaggedVerdict, "overlap");

  const flagged = await app.request(`/v1/designs/scope-match?projectId=proj-1&sessionId=s2&path=a.ts`, { headers: bearer(admin.token) });
  assert.deepEqual(await flagged.json(), { state: "flagged", designId: flaggedId });
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

  await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "first", creates: [], touches: ["shared.ts"], dependsOn: [] }),
  });
  const secondRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s2", summary: "second, overlapping", creates: [], touches: ["shared.ts"], dependsOn: [] }),
  });
  const secondBody = (await secondRes.json()) as { verdict: string; designId: string };
  assert.equal(secondBody.verdict, "overlap"); // and is now flagged, not open (design_gate.go's Edit/Write check would stop seeing it as usable)

  const thirdRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s3", summary: "third, also overlapping", creates: [], touches: ["shared.ts"], dependsOn: [] }),
  });
  const thirdBody = (await thirdRes.json()) as { verdict: string; conflicts: { conflictingDesignId: string }[] };
  assert.equal(thirdBody.verdict, "overlap", "a flagged design must not become invisible to new registrations' overlap checks");
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
        assert.deepEqual(await amendRes.json(), { verdict: "clean", designId });
      },
    ),
  );

  const scopeMatch = await app.request(`/v1/designs/scope-match?projectId=proj-1&sessionId=s1&path=b.ts`, { headers: bearer(admin.token) });
  assert.deepEqual(await scopeMatch.json(), { state: "in_scope", designId });

  const listRes = await app.request(`/v1/designs?projectId=proj-1&sessionId=s1`, { headers: bearer(admin.token) });
  const listBody = (await listRes.json()) as { items: { id: string; touches: string[] }[] };
  assert.deepEqual(listBody.items.find((d) => d.id === designId)?.touches, ["a.ts", "b.ts"]);
});

test("POST /v1/designs/:id/amend: a conflicting amendment is rejected and leaves the design's existing scope untouched", async () => {
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
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "", creates: [], touches: ["a.ts"], dependsOn: [] }),
  });
  const { designId } = (await registerRes.json()) as { designId: string };

  const amendRes = await app.request(`/v1/designs/${designId}/amend`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ addTouches: ["shared.ts"] }),
  });
  const amendBody = (await amendRes.json()) as { verdict: string; designId: string };
  assert.equal(amendBody.verdict, "overlap");

  // The design must still be open (amendment rejected, not the design itself)
  // and its scope must be exactly what it was before the amend attempt.
  const listRes = await app.request(`/v1/designs?projectId=proj-1&sessionId=s1`, { headers: bearer(admin.token) });
  const listBody = (await listRes.json()) as { items: { id: string; status: string; touches: string[] }[] };
  const design = listBody.items.find((d) => d.id === designId);
  assert.equal(design?.status, "open");
  assert.deepEqual(design?.touches, ["a.ts"]);
});

test("POST /v1/designs/:id/amend: supersedes a still-running semantic-comparator pass from the prior registration (kill stale, retain findings, start fresh)", async () => {
  const { app, dataDir } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s-other1", summary: "", creates: [], touches: ["other1.ts"], dependsOn: [] }),
  });
  await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s-other2", summary: "", creates: [], touches: ["other2.ts"], dependsOn: [] }),
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

test("POST /v1/designs/:id/resume: a conflicting resume is rejected and the design stays dormant", async () => {
  const { app, dataDir, designs } = freshApp();
  const admin = await bootstrapAdmin(app, dataDir);

  const firstRes = await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "", creates: [], touches: ["shared.ts"], dependsOn: [], ttlMs: 10 }),
  });
  const { designId } = (await firstRes.json()) as { designId: string };
  designs.sweepExpired(Date.now() + 1000); // -> dormant

  await app.request("/v1/designs/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s2", summary: "", creates: [], touches: ["shared.ts"], dependsOn: [] }),
  });

  const resumeRes = await app.request(`/v1/designs/${designId}/resume`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(admin.token) },
    body: JSON.stringify({ sessionId: "s1" }),
  });
  const resumeBody = (await resumeRes.json()) as { verdict: string };
  assert.equal(resumeBody.verdict, "overlap");

  const listRes = await app.request(`/v1/designs?projectId=proj-1&sessionId=s1`, { headers: bearer(admin.token) });
  const listBody = (await listRes.json()) as { items: { id: string; status: string }[] };
  assert.equal(listBody.items.find((d) => d.id === designId)?.status, "dormant"); // untouched by the rejected attempt
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
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "unrelated second task", creates: [], touches: ["b.ts"], dependsOn: [] }),
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
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s1", summary: "", creates: [], touches: ["a.ts"], dependsOn: [] }),
  });

  const notices = await app.request("/v1/notices?since=0", { headers: bearer(admin.token) });
  const noticesBody = (await notices.json()) as { items: { message: string }[] };
  assert.equal(
    noticesBody.items.filter((n) => n.message.includes("also have design")).length,
    0,
    "already caught by the real overlap/flagged path -- no double-signal",
  );
});

test("POST /v1/designs/check: a non-overlapping design from a *different* session does not fire a stale-sibling notice", async () => {
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
    body: JSON.stringify({ projectId: "proj-1", sessionId: "s2", summary: "", creates: [], touches: ["b.ts"], dependsOn: [] }),
  });

  const notices = await app.request("/v1/notices?since=0", { headers: bearer(admin.token) });
  const noticesBody = (await notices.json()) as { items: { message: string }[] };
  assert.equal(
    noticesBody.items.filter((n) => n.message.includes("also have design")).length,
    0,
    "the nudge is scoped to same-session siblings only",
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
