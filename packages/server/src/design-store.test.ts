import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createDb } from "./db/client.js";
import { DesignRegistry, ConstraintStore } from "./design-store.js";
import { DrizzleActivityLog } from "./activity-log.js";

function tmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "twing-design-store-test-"));
}

function freshRegistry() {
  return new DesignRegistry(createDb({ memory: true }));
}

test("DesignRegistry: openDesigns excludes the candidate itself", () => {
  const registry = freshRegistry();
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: ["X"], touches: [], dependsOn: [] });
  const b = registry.register({ projectId: "p1", developerId: "d2", sessionId: "s2", summary: "", creates: ["Y"], touches: [], dependsOn: [] });
  const open = registry.openDesigns("p1", Date.now(), a.id);
  assert.equal(open.length, 1);
  assert.equal(open[0].id, b.id);
  registry.stop();
});

test("DesignRegistry: TTL expiry excludes designs past createdAt+ttlMs", () => {
  const registry = freshRegistry();
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: [], dependsOn: [], ttlMs: 10 });
  const open = registry.openDesigns("p1", a.createdAt + 1000);
  assert.equal(open.length, 0);
  registry.stop();
});

test("DesignRegistry: supersede marks status and closedAt", () => {
  const registry = freshRegistry();
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: [], dependsOn: [] });
  const superseded = registry.supersede(a.id);
  assert.equal(superseded?.status, "superseded");
  assert.ok(superseded?.closedAt);
  registry.stop();
});

test("DesignRegistry: closeSession closes every open design for a session, ignores others", () => {
  const registry = freshRegistry();
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: [], dependsOn: [] });
  const b = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: [], dependsOn: [] });
  const c = registry.register({ projectId: "p1", developerId: "d2", sessionId: "s2", summary: "", creates: [], touches: [], dependsOn: [] });
  const count = registry.closeSession("s1");
  assert.equal(count, 2);
  assert.equal(registry.get(a.id)?.status, "closed");
  assert.equal(registry.get(b.id)?.status, "closed");
  assert.equal(registry.get(c.id)?.status, "open");
  registry.stop();
});

test("DesignRegistry: approving a justified-divergence review reopens the design", () => {
  const registry = freshRegistry();
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: [], dependsOn: [] });
  const review = registry.addReview(a.id, "p1", "we need a second retry strategy for streaming");
  registry.decideReview(review.id, "approve");
  assert.equal(registry.get(a.id)?.status, "open");
  registry.stop();
});

test("DesignRegistry: rejecting a review closes the design (§17 scope enforcement, 2026-08 -- previously left it open forever)", () => {
  const registry = freshRegistry();
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: [], dependsOn: [] });
  const review = registry.addReview(a.id, "p1", "just because");
  registry.decideReview(review.id, "reject");
  const rejected = registry.get(a.id);
  assert.equal(rejected?.status, "closed");
  assert.ok(rejected?.closedAt);
  assert.equal(registry.getReview(review.id)?.decision, "reject");
  registry.stop();
});

test("DesignRegistry: decideReview stamps reviewDecision on the design, surviving a later close", () => {
  const registry = freshRegistry();
  const approved = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: [], dependsOn: [] });
  const rejected = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s2", summary: "", creates: [], touches: [], dependsOn: [] });

  const approveReview = registry.addReview(approved.id, "p1", "fine, diverge");
  registry.decideReview(approveReview.id, "approve");
  const rejectReview = registry.addReview(rejected.id, "p1", "please don't");
  registry.decideReview(rejectReview.id, "reject");

  assert.equal(registry.get(approved.id)?.reviewDecision, "approve");
  assert.equal(registry.get(rejected.id)?.reviewDecision, "reject");

  // Close the approved one normally afterward -- the precedent must survive.
  registry.close(approved.id);
  assert.equal(registry.get(approved.id)?.status, "closed");
  assert.equal(registry.get(approved.id)?.reviewDecision, "approve", "review decision must survive a subsequent normal close");
  registry.stop();
});

test("DesignRegistry: every transition appends a matching activity_events row", () => {
  const db = createDb({ memory: true });
  const log = new DrizzleActivityLog(db);
  const registry = new DesignRegistry(db);

  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: [], dependsOn: [] });
  assert.equal(log.eventsForRelatedId(a.id).filter((e) => e.kind === "design_registered").length, 1);

  registry.close(a.id);
  assert.equal(log.eventsForRelatedId(a.id).filter((e) => e.kind === "design_closed").length, 1);

  const b = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s2", summary: "", creates: [], touches: [], dependsOn: [] });
  registry.supersede(b.id);
  assert.equal(log.eventsForRelatedId(b.id).filter((e) => e.kind === "design_resolved").length, 1);

  const c = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s3", summary: "", creates: [], touches: [], dependsOn: [] });
  const review = registry.addReview(c.id, "p1", "justified");
  assert.equal(log.eventsForRelatedId(review.id).filter((e) => e.kind === "review_created").length, 1);
  registry.decideReview(review.id, "approve");
  assert.equal(log.eventsForRelatedId(review.id).filter((e) => e.kind === "review_decided").length, 1);

  registry.stop();
});

test("DesignRegistry: durable across two instances pointed at the same database file", () => {
  const dataDir = tmpDataDir();
  const registry1 = new DesignRegistry(createDb({ dataDir }));
  const a = registry1.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "survives a restart", creates: [], touches: [], dependsOn: [] });
  registry1.stop();

  const registry2 = new DesignRegistry(createDb({ dataDir }));
  const reloaded = registry2.get(a.id);
  assert.equal(reloaded?.summary, "survives a restart");
  assert.equal(reloaded?.status, "open");
  registry2.stop();
});

// --- §17 scope enforcement (2026-08): flag / amend / broadened "live" queries ---

test("DesignRegistry: flag demotes an open design to flagged and logs the verdict", () => {
  const db = createDb({ memory: true });
  const log = new DrizzleActivityLog(db);
  const registry = new DesignRegistry(db);
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: [], dependsOn: [] });
  const flagged = registry.flag(a.id, "overlap");
  assert.equal(flagged?.status, "flagged");
  const events = log.eventsForRelatedId(a.id).filter((e) => e.kind === "design_flagged");
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].payload, { verdict: "overlap" });
  registry.stop();
});

test("DesignRegistry: flag is a no-op on a design that isn't open", () => {
  const registry = freshRegistry();
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: [], dependsOn: [] });
  registry.close(a.id);
  const result = registry.flag(a.id, "overlap");
  assert.equal(result?.status, "closed"); // unchanged, not clobbered to "flagged"
  registry.stop();
});

test("DesignRegistry: openDesigns includes flagged designs, not just open ones", () => {
  const registry = freshRegistry();
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: [], dependsOn: [] });
  registry.flag(a.id, "overlap");
  const b = registry.register({ projectId: "p1", developerId: "d2", sessionId: "s2", summary: "", creates: [], touches: [], dependsOn: [] });
  registry.close(b.id);

  const open = registry.openDesigns("p1");
  assert.equal(open.length, 1);
  assert.equal(open[0].id, a.id); // flagged is "live" for conflict-comparison purposes; closed is not
  registry.stop();
});

test("DesignRegistry: amend merges scope, bumps scopeVersion, and logs the delta", () => {
  const db = createDb({ memory: true });
  const log = new DrizzleActivityLog(db);
  const registry = new DesignRegistry(db);
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: ["a.ts"], dependsOn: [] });
  assert.equal(a.scopeVersion, 1);

  const amended = registry.amend(a.id, { touches: ["b.ts"] });
  assert.deepEqual(amended?.touches, ["a.ts", "b.ts"]);
  assert.equal(amended?.scopeVersion, 2);

  const events = log.eventsForRelatedId(a.id).filter((e) => e.kind === "design_amended");
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].payload, { addedTouches: ["b.ts"], addedCreates: [], addedDependsOn: [] });
  registry.stop();
});

test("DesignRegistry: amend refuses a design that isn't open", () => {
  const registry = freshRegistry();
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: [], dependsOn: [] });
  registry.flag(a.id, "overlap");
  const result = registry.amend(a.id, { touches: ["b.ts"] });
  assert.equal(result, undefined);
  assert.deepEqual(registry.get(a.id)?.touches, []); // untouched
  registry.stop();
});

test("DesignRegistry: close also closes a flagged design, not just an open one", () => {
  const registry = freshRegistry();
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: [], dependsOn: [] });
  registry.flag(a.id, "overlap");
  const closed = registry.close(a.id);
  assert.equal(closed?.status, "closed");
  assert.ok(closed?.closedAt);
  registry.stop();
});

test("DesignRegistry: closeSession also closes flagged designs for the session", () => {
  const registry = freshRegistry();
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: [], dependsOn: [] });
  registry.flag(a.id, "overlap");
  const count = registry.closeSession("s1");
  assert.equal(count, 1);
  assert.equal(registry.get(a.id)?.status, "closed");
  registry.stop();
});

test("ConstraintStore: add is idempotent per (projectId, statement) and persists across instances", () => {
  const dataDir = tmpDataDir();
  const store1 = new ConstraintStore(createDb({ dataDir }));
  const c1 = store1.add("p1", "use pkg/retry", ["src/**"], "canonical_abstraction", "seeded");
  const c2 = store1.add("p1", "use pkg/retry", ["src/**"], "canonical_abstraction", "seeded");
  assert.equal(c1.id, c2.id);

  const store2 = new ConstraintStore(createDb({ dataDir }));
  assert.equal(store2.forProject("p1").length, 1);
});
