import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import * as schema from "./db/schema.js";
import { createDb } from "./db/client.js";
import { designDocuments, designs } from "./db/schema.js";
import { DesignRegistry } from "./design-store.js";
import { buildDocumentSources, DesignDocumentService, MAX_DOCUMENT_INPUT_BYTES, parseDesignDocument } from "./design-document.js";

const output = JSON.stringify({ schemaVersion: 1, title: "Preserve concurrent updates", sections: {
  problemStatement: "An old editor can erase a newer amendment.",
  solutionAbstract: "Compare the source version before saving.", fullSolution: "Keep the draft and let the reader reconcile both versions.",
  validation: "  ",
} });

function setup(t: TestContext, callModel = async (_system: string, _input: string) => output) {
  const db = createDb({ memory: true });
  const registry = new DesignRegistry(db);
  const service = new DesignDocumentService(db, { callModel });
  t.after(() => { registry.stop(); service.stop(); });
  const register = (projectId = "cli", groupId?: string, plan = "## Problem\nAn old save erases newer work.\n## Solution\nCheck versions.") => registry.register({
    projectId, developerId: "alice", sessionId: "s", groupId,
    summary: "Preserve concurrent updates", rawPlanExcerpt: plan, creates: [], touches: ["src/editor.ts"], dependsOn: [],
  });
  return { db, registry, service, register };
}

test("document parser removes empty sections and rejects invalid content", () => {
  assert.equal(parseDesignDocument(output)?.sections.validation, undefined);
  assert.ok(parseDesignDocument("```json\n" + output + "\n```"));
  for (const invalid of ["not JSON", "null", "[]", '{"schemaVersion":2}',
    '{"schemaVersion":1,"title":"x","sections":{}}',
    '{"schemaVersion":1,"title":"x","sections":{"validation":4}}',
    '{"schemaVersion":1,"title":"x","sections":{"unknown":"text"}}']) assert.equal(parseDesignDocument(invalid), undefined);
});

test("single design registration durably queues an optional-section document", async (t) => {
  const { service, register } = setup(t);
  const design = register();
  assert.equal(service.response(design.id).status, "pending");
  await service.processPending();
  const response = service.response(design.id);
  assert.equal(response.status, "ready");
  assert.equal(response.revision, 1);
  assert.equal(response.stale, false);
  assert.equal(response.content?.title, "Preserve concurrent updates");
});

test("linked sources send each complete shared plan once and keep distinct contributions", async (t) => {
  let input = "";
  const { service, register } = setup(t, async (_system, source) => { input = source; return output; });
  const fullPlan = "Full reasoning " + "detail ".repeat(1500) + "END OF PLAN";
  const a = register("cli", undefined, fullPlan);
  register("monitor", a.id, fullPlan);
  register("other", a.id, "Distinct integration plan");
  await service.generate(a.id);
  const sources = JSON.parse(input);
  assert.equal(sources.plans.length, 2);
  assert.ok(sources.plans.includes(fullPlan));
  assert.equal(sources.members.length, 3);
  assert.deepEqual(sources.members.map((m: { projectId: string }) => m.projectId).sort(), ["cli", "monitor", "other"]);
  assert.ok(input.includes("END OF PLAN"));
});

test("invalid model output retries once, then records a safe failure", async (t) => {
  let calls = 0;
  const { service, register } = setup(t, async () => { calls++; return "not JSON"; });
  const a = register();
  await service.generate(a.id);
  assert.equal(calls, 2);
  assert.equal(service.get(a.id)?.lastErrorCode, "invalid_output");
  assert.equal(service.response(a.id).content, undefined);
});

test("malformed first response can recover on the single retry", async (t) => {
  let calls = 0;
  const { service, register } = setup(t, async () => ++calls === 1 ? "{}" : output);
  const a = register();
  await service.generate(a.id);
  assert.equal(calls, 2);
  assert.equal(service.response(a.id).status, "ready");
});

test("a linked amendment without counter increments discards an in-flight result", async (t) => {
  let release!: (text: string) => void;
  let calls = 0;
  const { service, register, db } = setup(t, async () => ++calls === 1 ? new Promise<string>((resolve) => { release = resolve; }) : output);
  const a = register();
  const b = register("monitor", a.id);
  const job = service.generate(a.id);
  assert.equal(service.generate(a.id), job, "one flight per group");
  db.update(designs).set({ summary: "Also preserve amendments" }).where(eq(designs.id, b.id)).run();
  release(output);
  await job;
  assert.equal(service.response(a.id).revision, 0);
  assert.equal(service.response(a.id).status, "pending");
  await service.processPending();
  assert.equal(service.response(a.id).revision, 1);
});

test("source write and invalidation roll back together", (t) => {
  const { register, service, db } = setup(t);
  const a = register();
  const before = service.get(a.id);
  assert.throws(() => db.transaction(() => {
    db.update(designs).set({ summary: "rolled back" }).where(eq(designs.id, a.id)).run();
    throw new Error("abort");
  }));
  assert.deepEqual(service.get(a.id), before);
  assert.equal(db.select().from(designs).where(eq(designs.id, a.id)).get()?.summary, a.summary);
});

test("relink queues both groups and retains the old published source projects", async (t) => {
  const { register, service, registry } = setup(t);
  const a = register();
  const b = register("monitor", a.id);
  await service.generate(a.id);
  registry.relink(b.id, "new-group");
  assert.equal(service.response(a.id).status, "pending");
  assert.equal(service.response(a.id).stale, true);
  assert.equal(service.response("new-group").status, "pending");
  assert.deepEqual(JSON.parse(service.get(a.id)!.publishedSourceProjects), ["cli", "monitor"]);
  await service.processPending();
  assert.deepEqual(JSON.parse(service.get(a.id)!.publishedSourceProjects), ["cli"]);
});

test("overview and declaration edits queue work; heartbeat and status changes do not", async (t) => {
  const { register, service, registry, db } = setup(t);
  const a = register();
  await service.generate(a.id);
  const version = service.get(a.id)!.requestedVersion;
  db.update(designs).set({ lastActivityAt: Date.now() + 100, status: "closed" }).where(eq(designs.id, a.id)).run();
  assert.equal(service.get(a.id)!.requestedVersion, version);
  registry.reviseOverview(a.id, { title: "New title", actor: "alice", source: "owner_edit" });
  assert.equal(service.response(a.id).status, "pending");
  await service.generate(a.id);
  db.update(designs).set({ touches: '["src/new.ts"]' }).where(eq(designs.id, a.id)).run();
  assert.equal(service.response(a.id).status, "pending");
});

test("model failure preserves the prior document and registration, and retry recovers", async (t) => {
  let fail = false;
  const { register, service, db, registry } = setup(t, async () => { if (fail) throw new Error("secret provider details"); return output; });
  const a = register();
  await service.generate(a.id);
  db.update(designs).set({ rawPlanExcerpt: "New complete plan" }).where(eq(designs.id, a.id)).run();
  fail = true;
  await service.generate(a.id);
  assert.equal(service.response(a.id).status, "failed");
  assert.equal(service.response(a.id).stale, true);
  assert.ok(service.response(a.id).content);
  assert.ok(registry.get(a.id));
  assert.equal(service.get(a.id)?.lastErrorCode, "model_failed");
  fail = false;
  service.request(a.id);
  await service.generate(a.id);
  assert.equal(service.response(a.id).revision, 2);
});

test("oversized full plans are unavailable rather than silently truncated", async (t) => {
  let calls = 0;
  const { register, service } = setup(t, async () => { calls++; return output; });
  const a = register("cli", undefined, "x".repeat(MAX_DOCUMENT_INPUT_BYTES));
  await service.generate(a.id);
  assert.equal(calls, 0);
  assert.equal(service.get(a.id)?.lastErrorCode, "input_too_large");
  assert.equal(service.response(a.id).status, "unavailable");
});

test("ready and pending regeneration requests reuse the same source state", async (t) => {
  let calls = 0;
  const { register, service } = setup(t, async () => { calls++; return output; });
  const a = register();
  service.request(a.id);
  service.request(a.id);
  await service.generate(a.id);
  service.request(a.id);
  await service.processPending();
  assert.equal(calls, 1);
  assert.equal(service.response(a.id).revision, 1);
});

test("restart resumes persisted running work", async (t) => {
  const { register, db } = setup(t);
  const a = register();
  db.update(designDocuments).set({ generationStatus: "running" }).where(eq(designDocuments.groupId, a.id)).run();
  const restarted = new DesignDocumentService(db, { callModel: async () => output, pollMs: 100_000 });
  t.after(() => restarted.stop());
  restarted.start();
  await restarted.generate(a.id);
  assert.equal(restarted.response(a.id).status, "ready");
});

test("legacy null group IDs are groups of one and deleted groups are removed", async (t) => {
  const { register, db, service } = setup(t);
  const a = register();
  db.update(designs).set({ groupId: null }).where(eq(designs.id, a.id)).run();
  assert.equal(buildDocumentSources(db, a.id).memberCount, 1);
  await service.generate(a.id);
  db.delete(designs).where(eq(designs.id, a.id)).run();
  await service.processPending();
  assert.equal(service.response(a.id).status, "missing");
});

test("project reassignment changes the fingerprint and queues regeneration", (t) => {
  const { register, db, service } = setup(t);
  const a = register();
  const before = buildDocumentSources(db, a.id).fingerprint;
  db.update(designs).set({ projectId: "new-project" }).where(eq(designs.id, a.id)).run();
  assert.notEqual(buildDocumentSources(db, a.id).fingerprint, before);
  assert.equal(service.get(a.id)?.requestedVersion, 2);
});

test("no provider records unavailable without losing the source design", async (t) => {
  const envKeys = ["AWS_BEARER_TOKEN_BEDROCK", "GOOGLE_APPLICATION_CREDENTIALS", "OPENROUTER_API_KEY", "TWING_BIFROST_BASE_URL"];
  const previous = envKeys.map((key) => process.env[key]);
  for (const key of envKeys) delete process.env[key];
  t.after(() => envKeys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }));
  const { db, register, registry } = setup(t);
  const service = new DesignDocumentService(db);
  const a = register();
  await service.generate(a.id);
  assert.equal(service.response(a.id).status, "unavailable");
  assert.equal(service.get(a.id)?.lastErrorCode, "no_provider");
  assert.ok(registry.get(a.id)?.rawPlanExcerpt);
});

test("a timed-out call fails safely and cannot publish its eventual result", async (t) => {
  const { db, register } = setup(t);
  let finish!: (text: string) => void;
  const service = new DesignDocumentService(db, { timeoutMs: 5, callModel: async () => new Promise<string>((resolve) => { finish = resolve; }) });
  const a = register();
  await service.generate(a.id);
  assert.equal(service.response(a.id).status, "failed");
  finish(output);
  await Promise.resolve();
  assert.equal(service.response(a.id).revision, 0);
});

test("upgrading a populated database preserves legacy designs and installs transactional triggers", async (t) => {
  const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
  const oldFolder = mkdtempSync(join(tmpdir(), "twing-old-document-schema-"));
  mkdirSync(join(oldFolder, "meta"));
  const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8"));
  journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 23);
  writeFileSync(join(oldFolder, "meta/_journal.json"), JSON.stringify(journal));
  for (const entry of journal.entries) copyFileSync(join(migrationsFolder, entry.tag + ".sql"), join(oldFolder, entry.tag + ".sql"));
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: oldFolder });
  const registry = new DesignRegistry(db);
  t.after(() => { registry.stop(); sqlite.close(); rmSync(oldFolder, { recursive: true, force: true }); });
  const original = registry.register({ projectId: "legacy", developerId: "alice", sessionId: "s", summary: "Legacy reasoning", rawPlanExcerpt: "Legacy complete plan", creates: [], touches: [], dependsOn: [] });
  const storedBeforeMigration = registry.get(original.id);
  migrate(db, { migrationsFolder });
  const service = new DesignDocumentService(db, { callModel: async () => output });
  assert.equal(service.response(original.id).status, "missing");
  assert.deepEqual(registry.get(original.id), storedBeforeMigration);
  registry.reviseOverview(original.id, { summary: "Corrected reasoning", actor: "alice", source: "owner_edit" });
  assert.equal(service.response(original.id).status, "pending");
  await service.processPending();
  assert.equal(service.response(original.id).status, "ready");
  assert.equal(registry.get(original.id)?.rawPlanExcerpt, "Legacy complete plan");
});
