import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createDb } from "./db/client.js";
import { designDocuments } from "./db/schema.js";
import { DesignRegistry } from "./design-store.js";
import { IdentityStore } from "./identity-store.js";
import { createApp } from "./app.js";
import { DesignDocumentService } from "./design-document.js";

function setup(t: TestContext) {
  const db = createDb({ memory: true });
  const dataDir = mkdtempSync(join(tmpdir(), "twing-document-routes-"));
  const identities = new IdentityStore(db, { dataDir });
  const designs = new DesignRegistry(db);
  const documents = new DesignDocumentService(db, { callModel: async () => JSON.stringify({
    schemaVersion: 1, title: "Shared problem", sections: { problemStatement: "Private source reasoning", solutionAbstract: "Shared solution" },
  }) });
  const app = createApp({ db, dataDir, identities, designs, designDocuments: documents, publicProjectIds: ["public"] });
  t.after(() => { documents.stop(); designs.stop(); rmSync(dataDir, { recursive: true, force: true }); });
  const hash = (s: string) => createHash("sha256").update(s).digest("hex");
  identities.foundProjectViaGithub("public", { tokenHash: hash("alice-token"), label: "alice" }, { owner: "org", repo: "public" });
  identities.foundProjectViaGithub("private", { developerId: "alice" }, { owner: "org", repo: "private" });
  identities.joinProject("public", "member", { tokenHash: hash("bob-token"), label: "bob" });
  const register = (projectId = "public", groupId?: string) => designs.register({
    projectId, groupId, developerId: "alice", sessionId: "session", summary: "Shared problem", rawPlanExcerpt: "Full plan",
    creates: [], touches: [], dependsOn: [],
  });
  const get = (id: string, token = "alice-token") => app.request(`/v1/designs/${id}/document`, { headers: { authorization: `Bearer ${token}` } });
  const post = (id: string, token = "alice-token") => app.request(`/v1/designs/${id}/document/regenerate`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  return { db, documents, designs, app, identities, register, get, post };
}

function postOverviewComment(app: ReturnType<typeof createApp>, id: string, groupId: string, token = "alice-token", revision = 1) {
  return app.request(`/v1/designs/${id}/comments`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ body: "Could this expose private source reasoning?", anchor: {
      field: "document:problemStatement", quote: "Private source reasoning", documentGroupId: groupId, documentRevision: revision,
    } }),
  });
}

test("shared overview comments are persisted once and readable from either group member", async (t) => {
  const { app, register, documents } = setup(t);
  const a = register();
  const b = register("private", a.id);
  await documents.generate(a.id);
  const posted = await postOverviewComment(app, a.id, a.id);
  assert.equal(posted.status, 200);
  const { comment } = await posted.json();
  assert.equal(comment.anchor.documentRevision, 1);
  for (const id of [a.id, b.id]) {
    const response = await app.request(`/v1/designs/${id}/comments`, { headers: { authorization: "Bearer alice-token" } });
    assert.deepEqual((await response.json()).items.map((item: { id: string }) => item.id), [comment.id]);
  }
});

test("overview comments refuse old revisions even when the quoted words survive", async (t) => {
  const { app, db, register, documents } = setup(t);
  const a = register();
  await documents.generate(a.id);
  db.update(designDocuments).set({ revision: 2 }).where(eq(designDocuments.groupId, a.id)).run();
  assert.equal((await postOverviewComment(app, a.id, a.id)).status, 409);
  assert.equal((await postOverviewComment(app, a.id, "wrong-group", "alice-token", 2)).status, 409);
  assert.equal((await postOverviewComment(app, a.id, a.id, "alice-token", 2)).status, 200);
});

test("private-source overview comments stay restricted after relinking and regenerating", async (t) => {
  const { app, register, documents, designs } = setup(t);
  const a = register();
  const b = register("private", a.id);
  await documents.generate(a.id);
  assert.equal((await postOverviewComment(app, a.id, a.id, "bob-token")).status, 403);
  const { comment } = await (await postOverviewComment(app, a.id, a.id)).json();
  await app.request(`/v1/comments/${comment.id}/replies`, {
    method: "POST", headers: { authorization: "Bearer alice-token", "content-type": "application/json" },
    body: JSON.stringify({ message: "Private details from the old shared document" }),
  });
  designs.relink(b.id, "new-group");
  await documents.generate(a.id);
  const headers = { authorization: "Bearer bob-token" };
  const response = await app.request(`/v1/designs/${a.id}/comments`, { headers });
  assert.deepEqual((await response.json()).items, []);
  for (const action of ["replies", "resolve"]) {
    const denied = await app.request(`/v1/comments/${comment.id}/${action}`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ message: "reply" }),
    });
    assert.equal(denied.status, 403);
  }
  const activity = await app.request("/v1/activity?projectId=public", { headers });
  assert.ok(!(await activity.text()).includes("Private details"));
  // Bob has participated in this design, so notifications would otherwise
  // include the private reply after regeneration removes its source project.
  await app.request(`/v1/designs/${a.id}/comments`, {
    method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ body: "General public comment" }),
  });
  const notifications = await app.request("/v1/notifications", { headers });
  const feed = await notifications.json();
  assert.ok(!JSON.stringify(feed).includes("Private details"));
  assert.ok(feed.items.every((item: { commentId: string }) => item.commentId !== comment.id));
});

test("public viewers read fully public overview comments but cannot post or reply", async (t) => {
  const { app, register, documents } = setup(t);
  const a = register();
  await documents.generate(a.id);
  const { comment } = await (await postOverviewComment(app, a.id, a.id)).json();
  const read = await app.request(`/v1/designs/${a.id}/comments`);
  assert.equal(read.status, 200);
  assert.equal((await read.json()).items[0].id, comment.id);
  assert.equal((await postOverviewComment(app, a.id, a.id, "")).status, 401);
});

test("document routes require authentication and hide inaccessible anchor IDs", async (t) => {
  const { register, app, get, post } = setup(t);
  const a = register("private");
  assert.equal((await app.request(`/v1/designs/${a.id}/document`, { headers: { authorization: "Bearer invalid" } })).status, 401);
  assert.equal((await get(a.id, "bob-token")).status, 404);
  assert.equal((await post(a.id, "bob-token")).status, 404);
  assert.equal((await get("missing")).status, 404);
});

test("reads return a shared document only with access to every current source project", async (t) => {
  const { register, documents, get, post } = setup(t);
  const a = register();
  register("private", a.id);
  await documents.generate(a.id);
  const allowed = await get(a.id);
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).content.title, "Shared problem");
  const restricted = await get(a.id, "bob-token");
  assert.equal(restricted.status, 403);
  assert.ok(!(await restricted.text()).includes("Private source reasoning"));
  assert.equal((await post(a.id, "bob-token")).status, 403);
});

test("stale published content remains restricted after a private member is relinked away", async (t) => {
  const { register, documents, designs, get, post } = setup(t);
  const a = register();
  const b = register("private", a.id);
  await documents.generate(a.id);
  designs.relink(b.id, "another-group");
  assert.equal((await get(a.id, "bob-token")).status, 403);
  const accepted = await post(a.id, "bob-token");
  assert.equal(accepted.status, 202);
  assert.equal((await accepted.json()).content, undefined);
  await documents.generate(a.id);
  assert.equal((await get(a.id, "bob-token")).status, 200);
});

test("public viewers read fully public documents but cannot request generation", async (t) => {
  const { register, documents, get, post } = setup(t);
  const a = register();
  await documents.generate(a.id);
  assert.equal((await get(a.id, "")).status, 200);
  assert.equal((await post(a.id, "")).status, 401);
  register("private", a.id);
  assert.equal((await get(a.id, "")).status, 403);
});

test("legacy designs report missing and member regeneration persists one request", async (t) => {
  const { register, documents, db, get, post } = setup(t);
  const a = register();
  db.delete(designDocuments).where(eq(designDocuments.groupId, a.id)).run();
  assert.equal((await (await get(a.id)).json()).status, "missing");
  assert.equal((await post(a.id, "bob-token")).status, 202);
  assert.equal((await post(a.id, "bob-token")).status, 202);
  assert.equal(documents.get(a.id)?.requestedVersion, 1);
  await documents.processPending();
  assert.equal((await (await get(a.id)).json()).status, "ready");
});

test("structured HTTP registration queues a document without scope extraction", async (t) => {
  const { app, documents, identities } = setup(t);
  const response = await app.request("/v1/designs/check", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer alice-token" },
    body: JSON.stringify({ projectId: "public", sessionId: "http-session", summary: "Explain the entire solution", rawPlanText: "## Problem\nSplit overviews obscure the solution.\n## Solution\nWrite a shared document.",
      changes: [{ id: "c1", action: "add", target: "src/document.ts", intent: "Generate shared prose" }], creates: ["src/document.ts"], touches: [], dependsOn: [] }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json();
  assert.equal(documents.get(result.groupId)?.generationStatus, "pending");
  await documents.processPending();
  assert.equal(documents.response(result.groupId).status, "ready");
  assert.ok(identities.getProjectRecord("public"));
});
