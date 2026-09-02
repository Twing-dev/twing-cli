import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_DESIGN_DORMANT_TTL_MS } from "@twing/core";
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

test("DesignRegistry: openDesignsForDeveloper finds a developer's open design in a different project", () => {
  const registry = freshRegistry();
  registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "first", creates: ["X"], touches: [], dependsOn: [] });
  const b = registry.register({ projectId: "p2", developerId: "d1", sessionId: "s2", summary: "second", creates: ["Y"], touches: [], dependsOn: [] });
  // Different developer, different project -- must not show up.
  registry.register({ projectId: "p3", developerId: "d2", sessionId: "s3", summary: "other dev", creates: ["Z"], touches: [], dependsOn: [] });
  const open = registry.openDesignsForDeveloper("d1", Date.now());
  assert.equal(open.length, 2);
  assert.ok(open.some((d) => d.id === b.id));
  registry.stop();
});

test("DesignRegistry: openDesignsForDeveloper excludes the given excludeId and non-open statuses", () => {
  const registry = freshRegistry();
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "a", creates: ["X"], touches: [], dependsOn: [] });
  const b = registry.register({ projectId: "p2", developerId: "d1", sessionId: "s2", summary: "b", creates: ["Y"], touches: [], dependsOn: [] });
  registry.close(b.id);
  const open = registry.openDesignsForDeveloper("d1", Date.now(), a.id);
  assert.equal(open.length, 0);
  registry.stop();
});

test("DesignRegistry: openDesignsForDeveloper excludes expired (TTL-elapsed) designs", () => {
  const registry = freshRegistry();
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "a", creates: [], touches: [], dependsOn: [], ttlMs: 10 });
  const open = registry.openDesignsForDeveloper("d1", a.createdAt + 1000);
  assert.equal(open.length, 0);
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

test("DesignRegistry: flag demotes an open design to flagged and logs the verdict + the design's own summary", () => {
  const db = createDb({ memory: true });
  const log = new DrizzleActivityLog(db);
  const registry = new DesignRegistry(db);
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "retry helper", creates: [], touches: [], dependsOn: [] });
  const flagged = registry.flag(a.id, "file_overlap");
  assert.equal(flagged?.status, "flagged");
  const events = log.eventsForRelatedId(a.id).filter((e) => e.kind === "design_flagged");
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].payload, { verdict: "file_overlap", summary: "retry helper" });
  registry.stop();
});

test("DesignRegistry: flag stamps blockedReason directly on the design, and it survives being read back by get()", () => {
  const db = createDb({ memory: true });
  const registry = new DesignRegistry(db);
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "retry helper", creates: [], touches: [], dependsOn: [] });
  assert.equal(registry.get(a.id)?.blockedReason, undefined, "sanity check: unset until flagged");
  registry.flag(a.id, "symbol_conflict");
  assert.equal(registry.get(a.id)?.blockedReason, "symbol_conflict");
  registry.stop();
});

test("DesignRegistry: blockedReason clears on an approved resolve (back to open) but survives a rejected one (closed)", () => {
  const db = createDb({ memory: true });
  const registry = new DesignRegistry(db);
  const approved = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "a", creates: [], touches: [], dependsOn: [] });
  const rejected = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s2", summary: "b", creates: [], touches: [], dependsOn: [] });
  registry.flag(approved.id, "llm_divergence");
  registry.flag(rejected.id, "llm_divergence");

  const approvedReview = registry.addReview(approved.id, "p1", "j");
  registry.decideReview(approvedReview.id, "approve");
  assert.equal(registry.get(approved.id)?.status, "open");
  assert.equal(registry.get(approved.id)?.blockedReason, undefined, "an approved resolve must clear the stale reason -- the design is unblocked now");

  const rejectedReview = registry.addReview(rejected.id, "p1", "j");
  registry.decideReview(rejectedReview.id, "reject");
  assert.equal(registry.get(rejected.id)?.status, "closed");
  assert.equal(registry.get(rejected.id)?.blockedReason, "llm_divergence", "a rejected review closes the design -- the reason stays as meaningful history, not stale");
  registry.stop();
});

test("DesignRegistry: mergeResolve replaces scope, clears the flag, bumps scopeVersion, and only works on a flagged design", () => {
  const db = createDb({ memory: true });
  const log = new DrizzleActivityLog(db);
  const registry = new DesignRegistry(db);
  const d = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "quotas", creates: ["new.ts"], touches: ["a.ts", "shared.ts"], dependsOn: [] });

  assert.equal(registry.mergeResolve(d.id, { touches: ["a.ts"], creates: [] }), undefined, "an open (not flagged) design has nothing to merge-resolve");

  registry.flag(d.id, "llm_divergence");
  const before = registry.get(d.id)!;
  const merged = registry.mergeResolve(d.id, { touches: ["a.ts"], creates: [] });
  assert.equal(merged?.status, "open");
  assert.equal(merged?.blockedReason, undefined);
  assert.deepEqual(merged?.touches, ["a.ts"], "replaced, not unioned -- shared.ts is dropped");
  assert.deepEqual(merged?.creates, []);
  assert.equal(merged?.scopeVersion, before.scopeVersion + 1);

  const events = log.eventsForRelatedId(d.id).filter((e) => e.kind === "design_resolved");
  assert.equal(events.length, 1);
  assert.equal((events[0].payload as { resolution: string }).resolution, "merged");
  registry.stop();
});

test("DesignRegistry: resume clears a stale blockedReason left over from before the design went dormant", () => {
  const db = createDb({ memory: true });
  const registry = new DesignRegistry(db);
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "a", creates: [], touches: [], dependsOn: [] });
  registry.flag(a.id, "symbol_conflict");
  registry.sweepExpired(Date.now() + a.ttlMs + 1);
  assert.equal(registry.get(a.id)?.status, "dormant", "sanity check: a flagged design demotes to dormant on TTL expiry, same as an open one");
  assert.equal(registry.get(a.id)?.blockedReason, "symbol_conflict", "sanity check: dormancy alone must not erase the reason -- it's still meaningful history");

  registry.resume(a.id, { sessionId: "s1", developerId: "d1", delta: {} });
  assert.equal(registry.get(a.id)?.status, "open");
  assert.equal(registry.get(a.id)?.blockedReason, undefined, "resuming to open must clear the now-stale reason");
  registry.stop();
});

test("DesignRegistry: flag's optional detail persists the full conflicts/constraint onto the event, not just the bare verdict", () => {
  const db = createDb({ memory: true });
  const log = new DrizzleActivityLog(db);
  const registry = new DesignRegistry(db);
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "retry helper", creates: [], touches: [], dependsOn: [] });

  const conflicts = [{ conflictingDesignId: "other-id", overlapKind: "touches" as const, overlapDetail: "both touch a.ts", conflictingSummary: "other design", overlapPaths: ["a.ts"] }];
  registry.flag(a.id, "file_overlap", { conflicts });
  const events = log.eventsForRelatedId(a.id).filter((e) => e.kind === "design_flagged");
  assert.deepEqual(events[0].payload, { verdict: "file_overlap", summary: "retry helper", conflicts });
  registry.stop();
});

test("DesignRegistry: flag's optional detail persists a constraint match, and omits an empty conflicts array rather than logging []", () => {
  const db = createDb({ memory: true });
  const log = new DrizzleActivityLog(db);
  const registry = new DesignRegistry(db);
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "retry helper", creates: [], touches: [], dependsOn: [] });

  const constraint = { id: "c1", statement: "use pkg/retry", type: "constraint" as const };
  registry.flag(a.id, "constraint_violation", { conflicts: [], constraints: [constraint] });
  const events = log.eventsForRelatedId(a.id).filter((e) => e.kind === "design_flagged");
  assert.deepEqual(events[0].payload, { verdict: "constraint_violation", summary: "retry helper", constraints: [constraint] });
  registry.stop();
});

test("DesignRegistry: flag is a no-op on a design that isn't open", () => {
  const registry = freshRegistry();
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: [], dependsOn: [] });
  registry.close(a.id);
  const result = registry.flag(a.id, "file_overlap");
  assert.equal(result?.status, "closed"); // unchanged, not clobbered to "flagged"
  registry.stop();
});

test("DesignRegistry: openDesigns includes flagged designs, not just open ones", () => {
  const registry = freshRegistry();
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: [], dependsOn: [] });
  registry.flag(a.id, "file_overlap");
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
  registry.flag(a.id, "file_overlap");
  const result = registry.amend(a.id, { touches: ["b.ts"] });
  assert.equal(result, undefined);
  assert.deepEqual(registry.get(a.id)?.touches, []); // untouched
  registry.stop();
});

test("DesignRegistry: close also closes a flagged design, not just an open one", () => {
  const registry = freshRegistry();
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: [], dependsOn: [] });
  registry.flag(a.id, "file_overlap");
  const closed = registry.close(a.id);
  assert.equal(closed?.status, "closed");
  assert.ok(closed?.closedAt);
  registry.stop();
});

test("DesignRegistry: closeSession also closes flagged designs for the session", () => {
  const registry = freshRegistry();
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: [], dependsOn: [] });
  registry.flag(a.id, "file_overlap");
  const count = registry.closeSession("s1");
  assert.equal(count, 1);
  assert.equal(registry.get(a.id)?.status, "closed");
  registry.stop();
});

// --- §17 design lifecycle (2026-08): touch / two-stage sweep / resume ---

test("DesignRegistry: touch bumps lastActivityAt", async () => {
  const registry = freshRegistry();
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: [], dependsOn: [] });
  await new Promise((resolve) => setTimeout(resolve, 5));
  registry.touch(a.id);
  const after = registry.get(a.id);
  assert.ok(after && after.lastActivityAt > a.lastActivityAt);
  registry.stop();
});

test("DesignRegistry: openDesigns' TTL basis is lastActivityAt, not createdAt -- proves the actual point of the feature", async () => {
  const registry = freshRegistry();
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: [], dependsOn: [], ttlMs: 10 });
  await new Promise((resolve) => setTimeout(resolve, 50)); // real gap so lastActivityAt measurably outpaces createdAt
  registry.touch(a.id);
  const touched = registry.get(a.id)!;
  assert.ok(touched.lastActivityAt > a.createdAt + 10, "sanity: touch happened well after createdAt+ttlMs would already have expired it");

  // Past createdAt+ttlMs (would have excluded it under the old basis), but
  // still comfortably inside lastActivityAt+ttlMs.
  const now = a.createdAt + 30;
  const open = registry.openDesigns("p1", now);
  assert.equal(open.length, 1, "still live -- genuinely active work must not die just for being old");
  registry.stop();
});

test("DesignRegistry: amend also refreshes lastActivityAt -- amending is itself real activity", async () => {
  const registry = freshRegistry();
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: ["a.ts"], dependsOn: [] });
  await new Promise((resolve) => setTimeout(resolve, 5));
  registry.amend(a.id, { touches: ["b.ts"] });
  const after = registry.get(a.id);
  assert.ok(after && after.lastActivityAt > a.lastActivityAt);
  registry.stop();
});

test("DesignRegistry: sweepExpired demotes an inactive open design to dormant, not straight to expired", () => {
  const db = createDb({ memory: true });
  const log = new DrizzleActivityLog(db);
  const registry = new DesignRegistry(db);
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: [], dependsOn: [], ttlMs: 10 });

  // Well past the 10ms active TTL, nowhere near the 7-day dormant TTL --
  // isolates the first stage of the sweep from the second.
  registry.sweepExpired(a.createdAt + 1000);
  const dormant = registry.get(a.id);
  assert.equal(dormant?.status, "dormant");
  assert.equal(log.eventsForRelatedId(a.id).filter((e) => e.kind === "design_dormant").length, 1);
  registry.stop();
});

test("DesignRegistry: sweepExpired also demotes an inactive flagged design to dormant", () => {
  const registry = freshRegistry();
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: [], dependsOn: [], ttlMs: 10 });
  registry.flag(a.id, "file_overlap");
  registry.sweepExpired(a.createdAt + 1000);
  assert.equal(registry.get(a.id)?.status, "dormant");
  registry.stop();
});

test("DesignRegistry: sweepExpired terminally expires a dormant design past the dormant TTL", () => {
  const db = createDb({ memory: true });
  const log = new DrizzleActivityLog(db);
  const registry = new DesignRegistry(db);
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: [], dependsOn: [], ttlMs: 10 });

  registry.sweepExpired(a.createdAt + 1000); // -> dormant
  assert.equal(registry.get(a.id)?.status, "dormant");

  registry.sweepExpired(a.createdAt + DEFAULT_DESIGN_DORMANT_TTL_MS + 1000); // -> expired
  const expired = registry.get(a.id);
  assert.equal(expired?.status, "expired");
  assert.ok(expired?.closedAt);
  assert.equal(log.eventsForRelatedId(a.id).filter((e) => e.kind === "design_expired").length, 1);
  registry.stop();
});

test("DesignRegistry: openDesigns excludes dormant designs -- this is the actual n² fix", () => {
  const registry = freshRegistry();
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: [], dependsOn: [], ttlMs: 10 });
  registry.sweepExpired(a.createdAt + 1000);
  assert.equal(registry.get(a.id)?.status, "dormant");
  assert.equal(registry.openDesigns("p1").length, 0);
  registry.stop();
});

test("DesignRegistry: resume reactivates a dormant design, reassigning sessionId/developerId, bumping scopeVersion, and merging the delta", () => {
  const db = createDb({ memory: true });
  const log = new DrizzleActivityLog(db);
  const registry = new DesignRegistry(db);
  const a = registry.register({ projectId: "p1", developerId: "alice", sessionId: "s-alice", summary: "", creates: [], touches: ["a.ts"], dependsOn: [], ttlMs: 10 });
  registry.sweepExpired(a.createdAt + 1000);
  assert.equal(registry.get(a.id)?.status, "dormant");
  assert.equal(a.scopeVersion, 1);

  const resumed = registry.resume(a.id, { sessionId: "s-bob", developerId: "bob", delta: { touches: ["b.ts"] } });
  assert.equal(resumed?.status, "open");
  assert.equal(resumed?.sessionId, "s-bob");
  assert.equal(resumed?.developerId, "bob");
  assert.deepEqual(resumed?.touches, ["a.ts", "b.ts"]);
  assert.equal(resumed?.scopeVersion, 2);

  const events = log.eventsForRelatedId(a.id).filter((e) => e.kind === "design_resumed");
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].payload, { fromDeveloperId: "alice", toDeveloperId: "bob", fromSessionId: "s-alice", toSessionId: "s-bob" });
  registry.stop();
});

test("DesignRegistry: resume rejects a design that isn't dormant", () => {
  const registry = freshRegistry();
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: [], dependsOn: [] });
  const result = registry.resume(a.id, { sessionId: "s2", developerId: "d2", delta: {} });
  assert.equal(result, undefined);
  assert.equal(registry.get(a.id)?.status, "open"); // untouched
  registry.stop();
});

test("DesignRegistry: close also closes a dormant design", () => {
  const registry = freshRegistry();
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: [], dependsOn: [], ttlMs: 10 });
  registry.sweepExpired(a.createdAt + 1000);
  const closed = registry.close(a.id);
  assert.equal(closed?.status, "closed");
  registry.stop();
});

test("DesignRegistry: closeSession also closes dormant designs for the session", () => {
  const registry = freshRegistry();
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: [], dependsOn: [], ttlMs: 10 });
  registry.sweepExpired(a.createdAt + 1000);
  const count = registry.closeSession("s1");
  assert.equal(count, 1);
  assert.equal(registry.get(a.id)?.status, "closed");
  registry.stop();
});

// --- ExitPlanMode retry dedup (§17, 2026-08-18) ---

test("DesignRegistry: openPlanModeDesignForSession finds a candidate registered from rawPlanText", () => {
  const registry = freshRegistry();
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: [], dependsOn: [], rawPlanExcerpt: "the plan text" });
  const found = registry.openPlanModeDesignForSession("p1", "s1");
  assert.equal(found?.id, a.id);
  registry.stop();
});

test("DesignRegistry: openPlanModeDesignForSession ignores structured registrations (no rawPlanExcerpt)", () => {
  const registry = freshRegistry();
  registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "manually registered", creates: [], touches: [], dependsOn: [] });
  const found = registry.openPlanModeDesignForSession("p1", "s1");
  assert.equal(found, undefined);
  registry.stop();
});

test("DesignRegistry: openPlanModeDesignForSession ignores a different session or project", () => {
  const registry = freshRegistry();
  registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: [], dependsOn: [], rawPlanExcerpt: "text" });
  assert.equal(registry.openPlanModeDesignForSession("p1", "s2"), undefined);
  assert.equal(registry.openPlanModeDesignForSession("p2", "s1"), undefined);
  registry.stop();
});

test("DesignRegistry: openPlanModeDesignForSession finds a flagged candidate too, not just open", () => {
  const registry = freshRegistry();
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: [], dependsOn: [], rawPlanExcerpt: "text" });
  registry.flag(a.id, "file_overlap");
  const found = registry.openPlanModeDesignForSession("p1", "s1");
  assert.equal(found?.id, a.id);
  assert.equal(found?.status, "flagged");
  registry.stop();
});

test("DesignRegistry: openPlanModeDesignForSession ignores a dormant candidate -- resume is the only explicit revival path", () => {
  const registry = freshRegistry();
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: [], dependsOn: [], rawPlanExcerpt: "text", ttlMs: 10 });
  registry.sweepExpired(a.createdAt + 1000);
  assert.equal(registry.get(a.id)?.status, "dormant");
  assert.equal(registry.openPlanModeDesignForSession("p1", "s1"), undefined);
  registry.stop();
});

test("DesignRegistry: openPlanModeDesignForSession returns the most recent candidate when more than one exists", () => {
  const registry = freshRegistry();
  registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "older", creates: [], touches: [], dependsOn: [], rawPlanExcerpt: "text" });
  registry.close(registry.openPlanModeDesignForSession("p1", "s1")!.id); // close the first so overlap isn't the point of this test
  const b = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "newer", creates: [], touches: [], dependsOn: [], rawPlanExcerpt: "text 2" });
  const found = registry.openPlanModeDesignForSession("p1", "s1");
  assert.equal(found?.id, b.id);
  registry.stop();
});

test("DesignRegistry: reregisterFromPlan fully replaces scope, bumps scopeVersion, resets status to open, and logs design_registered", () => {
  const db = createDb({ memory: true });
  const log = new DrizzleActivityLog(db);
  const registry = new DesignRegistry(db);
  const a = registry.register({
    projectId: "p1",
    developerId: "d1",
    sessionId: "s1",
    summary: "old summary",
    creates: ["Old"],
    touches: ["old.ts"],
    dependsOn: [],
    rawPlanExcerpt: "old plan text",
  });
  registry.flag(a.id, "file_overlap"); // a candidate the caller found via openPlanModeDesignForSession may be flagged

  const reregistered = registry.reregisterFromPlan(a.id, {
    summary: "new summary",
    creates: ["New"],
    touches: ["new.ts"],
    dependsOn: ["Dep"],
    rawPlanExcerpt: "new plan text",
  });

  assert.equal(reregistered?.id, a.id, "same row, not a new id");
  assert.equal(reregistered?.status, "open");
  assert.equal(reregistered?.summary, "new summary");
  assert.deepEqual(reregistered?.creates, ["New"]);
  assert.deepEqual(reregistered?.touches, ["new.ts"]);
  assert.deepEqual(reregistered?.dependsOn, ["Dep"]);
  assert.equal(reregistered?.rawPlanExcerpt, "new plan text");
  assert.equal(reregistered?.scopeVersion, 2);

  const events = log.eventsForRelatedId(a.id).filter((e) => e.kind === "design_registered");
  assert.equal(events.length, 2, "one from the original register, one from reregisterFromPlan");
  registry.stop();
});

test("DesignRegistry: reregisterFromPlan is a full replace, not an additive merge -- a dropped file must not linger", () => {
  const registry = freshRegistry();
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: ["a.ts", "b.ts"], dependsOn: [], rawPlanExcerpt: "text" });
  const reregistered = registry.reregisterFromPlan(a.id, { summary: "", creates: [], touches: ["a.ts"], dependsOn: [], rawPlanExcerpt: "text 2" });
  assert.deepEqual(reregistered?.touches, ["a.ts"], "b.ts dropped out of the revised plan and must not survive a full replace");
  registry.stop();
});

test("DesignRegistry: reregisterFromPlan preserves justifiedConstraintIds -- a prior approval survives the retry", () => {
  const registry = freshRegistry();
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: [], dependsOn: [], rawPlanExcerpt: "text" });
  const review = registry.addReview(a.id, "p1", "justified", ["c1"]);
  registry.decideReview(review.id, "approve");
  assert.deepEqual(registry.get(a.id)?.justifiedConstraintIds, ["c1"]);
  const reregistered = registry.reregisterFromPlan(a.id, { summary: "s", creates: [], touches: [], dependsOn: [], rawPlanExcerpt: "text 2" });
  assert.deepEqual(reregistered?.justifiedConstraintIds, ["c1"]);
  registry.stop();
});

test("DesignRegistry: decideReview approve populates justifiedOverlaps from the review's overlapWaivers, reject leaves it untouched", () => {
  const registry = freshRegistry();
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: [], dependsOn: [] });
  const b = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s2", summary: "", creates: [], touches: [], dependsOn: [] });

  const rejected = registry.addReview(a.id, "p1", "nope", undefined, [{ conflictingDesignId: b.id, paths: ["file1.ts"] }]);
  registry.decideReview(rejected.id, "reject");
  assert.deepEqual(registry.get(a.id)?.justifiedOverlaps, [], "rejection settles nothing");

  const approved = registry.addReview(a.id, "p1", "fine, proceeding despite the overlap", undefined, [
    { conflictingDesignId: b.id, paths: ["file1.ts", "file2.ts"] },
  ]);
  registry.decideReview(approved.id, "approve");
  assert.deepEqual(registry.get(a.id)?.justifiedOverlaps.sort(), [`${b.id}::file1.ts`, `${b.id}::file2.ts`].sort());
  registry.stop();
});

test("DesignRegistry: decideReview approve populates justifiedConflicts from the review's conflictWaivers, reject leaves it untouched", () => {
  const registry = freshRegistry();
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: [], dependsOn: [] });
  const b = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s2", summary: "", creates: [], touches: [], dependsOn: [] });
  const c = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s3", summary: "", creates: [], touches: [], dependsOn: [] });

  const rejected = registry.addReview(a.id, "p1", "nope", undefined, undefined, [{ conflictingDesignId: b.id }]);
  registry.decideReview(rejected.id, "reject");
  assert.deepEqual(registry.get(a.id)?.justifiedConflicts, [], "rejection settles nothing");

  const approved = registry.addReview(a.id, "p1", "fine, proceeding despite the semantic conflict", undefined, undefined, [
    { conflictingDesignId: b.id },
    { conflictingDesignId: c.id },
  ]);
  registry.decideReview(approved.id, "approve");
  assert.deepEqual(registry.get(a.id)?.justifiedConflicts.sort(), [b.id, c.id].sort());
  registry.stop();
});

test("DesignRegistry: reregisterFromPlan preserves justifiedOverlaps -- a prior overlap approval survives the retry", () => {
  const registry = freshRegistry();
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: [], dependsOn: [], rawPlanExcerpt: "text" });
  const b = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s2", summary: "", creates: [], touches: [], dependsOn: [] });
  const review = registry.addReview(a.id, "p1", "justified", undefined, [{ conflictingDesignId: b.id, paths: ["file1.ts"] }]);
  registry.decideReview(review.id, "approve");
  assert.deepEqual(registry.get(a.id)?.justifiedOverlaps, [`${b.id}::file1.ts`]);
  const reregistered = registry.reregisterFromPlan(a.id, { summary: "s", creates: [], touches: [], dependsOn: [], rawPlanExcerpt: "text 2" });
  assert.deepEqual(reregistered?.justifiedOverlaps, [`${b.id}::file1.ts`]);
  registry.stop();
});

test("DesignRegistry: reregisterFromPlan returns undefined for a nonexistent id", () => {
  const registry = freshRegistry();
  const result = registry.reregisterFromPlan("no-such-id", { summary: "", creates: [], touches: [], dependsOn: [], rawPlanExcerpt: "text" });
  assert.equal(result, undefined);
  registry.stop();
});

// ---------------------------------------------------------------------------
// §17 design linking (groupId) -- 2026-08
// ---------------------------------------------------------------------------

test("DesignRegistry: register self-assigns groupId to its own id when none is supplied", () => {
  const registry = freshRegistry();
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: [], dependsOn: [] });
  assert.equal(a.groupId, a.id);
  registry.stop();
});

test("DesignRegistry: register honors a caller-supplied groupId", () => {
  const registry = freshRegistry();
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: [], dependsOn: [] });
  const b = registry.register({ projectId: "p2", developerId: "d1", sessionId: "s2", summary: "", creates: [], touches: [], dependsOn: [], groupId: a.id });
  assert.equal(b.groupId, a.id);
  assert.notEqual(b.groupId, b.id);
  registry.stop();
});

test("DesignRegistry: listByGroup returns every row sharing a groupId across projects, regardless of status", () => {
  const registry = freshRegistry();
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: [], dependsOn: [] });
  const b = registry.register({ projectId: "p2", developerId: "d2", sessionId: "s2", summary: "", creates: [], touches: [], dependsOn: [], groupId: a.groupId });
  registry.close(b.id);
  const group = registry.listByGroup(a.groupId!);
  assert.equal(group.length, 2);
  assert.deepEqual(
    group.map((d) => d.id).sort(),
    [a.id, b.id].sort(),
  );
  registry.stop();
});

test("DesignRegistry: listByGroup returns empty for an unknown groupId", () => {
  const registry = freshRegistry();
  assert.deepEqual(registry.listByGroup("no-such-group"), []);
  registry.stop();
});

test("DesignRegistry: amend's summaryUpdate propagates to a closed sibling in another project, appended onto the sibling's own summary", () => {
  const db = createDb({ memory: true });
  const log = new DrizzleActivityLog(db);
  const registry = new DesignRegistry(db);
  // `a` closes first, *while solo* (no siblings yet, so close()'s own
  // fan-out has nothing to propagate to) -- then `b` joins `a`'s group
  // afterward, open. This is the only reachable way to end up with one
  // open and one closed member of the same group: close()'s fan-out (see
  // its own test above) closes every open sibling the moment any one
  // member is closed, so two designs can't independently be "linked, one
  // open one closed" unless the closed one got there before the link
  // existed.
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "repo-A original summary", creates: [], touches: [], dependsOn: [] });
  registry.close(a.id);
  const b = registry.register({
    projectId: "p2",
    developerId: "d2",
    sessionId: "s2",
    summary: "repo-B original summary",
    creates: [],
    touches: [],
    dependsOn: [],
    groupId: a.id,
  });

  registry.amend(b.id, { summary: "repo-B original summary\n\nUpdate: shared note", summaryUpdate: "shared note" });

  const sibling = registry.get(a.id)!;
  assert.equal(sibling.status, "closed", "propagation must not reopen a closed sibling");
  assert.match(sibling.summary, /^repo-A original summary/, "sibling keeps its own original text, not the primary's");
  assert.match(sibling.summary, /shared note$/, "sibling gains its own appended update, not the primary's full merged string");
  assert.doesNotMatch(sibling.summary, /repo-B original summary/, "sibling must never receive the primary's own original text");

  const propagated = log.eventsForRelatedId(a.id).filter((e) => e.kind === "design_amended");
  assert.equal(propagated.length, 1);
  assert.equal((propagated[0].payload as { propagatedFromDesignId?: string }).propagatedFromDesignId, b.id);
  registry.stop();
});

test("DesignRegistry: amend with only scope fields (no summaryUpdate) does not propagate to siblings", () => {
  const registry = freshRegistry();
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: ["a.ts"], dependsOn: [] });
  const b = registry.register({ projectId: "p2", developerId: "d2", sessionId: "s2", summary: "repo-B summary", creates: [], touches: [], dependsOn: [], groupId: a.groupId });

  registry.amend(a.id, { touches: ["only-in-a.ts"] });

  assert.equal(registry.get(b.id)?.summary, "repo-B summary");
  registry.stop();
});

test("DesignRegistry: amend/close on an ungrouped design (groupId === own id) behave exactly as before -- no-op fan-out, no error", () => {
  const registry = freshRegistry();
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "solo", creates: [], touches: [], dependsOn: [] });
  const amended = registry.amend(a.id, { summary: "solo\n\nUpdate: note", summaryUpdate: "note" });
  assert.equal(amended?.summary, "solo\n\nUpdate: note");
  const closed = registry.close(a.id);
  assert.equal(closed?.status, "closed");
  registry.stop();
});

test("DesignRegistry: amend's groupId reassigns an ungrouped design's own groupId (join a group after the fact)", () => {
  const registry = freshRegistry();
  const anchor = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "anchor", creates: [], touches: [], dependsOn: [] });
  const solo = registry.register({ projectId: "p2", developerId: "d2", sessionId: "s2", summary: "was solo", creates: [], touches: [], dependsOn: [] });
  assert.equal(solo.groupId, solo.id, "starts as its own group of one");

  const amended = registry.amend(solo.id, { groupId: anchor.id });
  assert.equal(amended?.groupId, anchor.id);

  const group = registry.listByGroup(anchor.id);
  assert.deepEqual(
    group.map((d) => d.id).sort(),
    [anchor.id, solo.id].sort(),
  );
  registry.stop();
});

test("DesignRegistry: amend with both groupId and summaryUpdate propagates to the NEW group's siblings, not the old group's", () => {
  const registry = freshRegistry();
  const oldSibling = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "old group sibling", creates: [], touches: [], dependsOn: [] });
  const mover = registry.register({ projectId: "p2", developerId: "d2", sessionId: "s2", summary: "mover", creates: [], touches: [], dependsOn: [], groupId: oldSibling.id });
  const newAnchor = registry.register({ projectId: "p3", developerId: "d3", sessionId: "s3", summary: "new group anchor", creates: [], touches: [], dependsOn: [] });

  registry.amend(mover.id, { groupId: newAnchor.id, summary: "mover\n\nUpdate: joined a new group", summaryUpdate: "joined a new group" });

  assert.equal(registry.get(oldSibling.id)?.summary, "old group sibling", "the OLD group's sibling must not receive the update");
  assert.match(registry.get(newAnchor.id)!.summary, /joined a new group$/, "the NEW group's sibling must receive it");
  registry.stop();
});

test("DesignRegistry: a groupId-only amend (no scope/summary delta) succeeds and leaves everything else untouched", () => {
  const registry = freshRegistry();
  const anchor = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "anchor", creates: [], touches: [], dependsOn: [] });
  const target = registry.register({ projectId: "p2", developerId: "d2", sessionId: "s2", summary: "unchanged summary", creates: ["a.ts"], touches: ["b.ts"], dependsOn: ["c.ts"] });

  const amended = registry.amend(target.id, { groupId: anchor.id });
  assert.equal(amended?.groupId, anchor.id);
  assert.equal(amended?.summary, "unchanged summary");
  assert.deepEqual(amended?.creates, ["a.ts"]);
  assert.deepEqual(amended?.touches, ["b.ts"]);
  assert.deepEqual(amended?.dependsOn, ["c.ts"]);
  registry.stop();
});

test("DesignRegistry: amend's design_amended activity payload carries newGroupId", () => {
  const db = createDb({ memory: true });
  const log = new DrizzleActivityLog(db);
  const registry = new DesignRegistry(db);
  const anchor = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "anchor", creates: [], touches: [], dependsOn: [] });
  const target = registry.register({ projectId: "p2", developerId: "d2", sessionId: "s2", summary: "target", creates: [], touches: [], dependsOn: [] });

  registry.amend(target.id, { groupId: anchor.id });

  const events = log.eventsForRelatedId(target.id).filter((e) => e.kind === "design_amended");
  assert.equal(events.length, 1);
  assert.equal((events[0].payload as { newGroupId?: string }).newGroupId, anchor.id);
  registry.stop();
});

// §17 design linking follow-up (2026-08-28): relink() is the escape hatch
// for the case amend() can't handle -- a CLOSED design joining a group.
test("DesignRegistry: relink() joins a CLOSED design into a group -- amend() can't do this, that's the whole point", () => {
  const db = createDb({ memory: true });
  const log = new DrizzleActivityLog(db);
  const registry = new DesignRegistry(db);
  const anchor = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "anchor", creates: [], touches: [], dependsOn: [] });
  const target = registry.register({ projectId: "p2", developerId: "d2", sessionId: "s2", summary: "target", creates: ["a.ts"], touches: ["b.ts"], dependsOn: [] });
  registry.close(target.id);
  assert.equal(registry.get(target.id)?.status, "closed");

  // amend() itself still refuses -- confirms relink() isn't just a
  // permissive rename of the existing path.
  assert.equal(registry.amend(target.id, { groupId: anchor.id }), undefined);

  const relinked = registry.relink(target.id, anchor.id);
  assert.equal(relinked?.groupId, anchor.id);
  assert.equal(relinked?.status, "closed", "relink doesn't reopen the design");
  assert.deepEqual(relinked?.touches, ["b.ts"], "scope is untouched -- this is metadata-only");

  const group = registry.listByGroup(anchor.id);
  assert.deepEqual(
    group.map((d) => d.id).sort(),
    [anchor.id, target.id].sort(),
  );

  const events = log.eventsForRelatedId(target.id).filter((e) => e.kind === "design_amended");
  assert.equal(events.length, 1);
  assert.equal((events[0].payload as { newGroupId?: string }).newGroupId, anchor.id);
  registry.stop();
});

test("DesignRegistry: relink() returns undefined for a design that doesn't exist", () => {
  const registry = freshRegistry();
  assert.equal(registry.relink("no-such-id", "some-group"), undefined);
  registry.stop();
});

test("DesignRegistry: close propagates to every open/flagged/dormant sibling across projects, leaves an already-closed sibling's closedAt untouched", () => {
  const registry = freshRegistry();
  // `c` closes first, *while solo* (same reasoning as the amend/propagation
  // test above: close()'s own fan-out would otherwise immediately close a
  // and b too, the moment c joined their group, leaving nothing for the
  // later close(a.id) call below to actually exercise). `a` and `b` join
  // c's group afterward, both open.
  const c = registry.register({ projectId: "p3", developerId: "d3", sessionId: "s3", summary: "", creates: [], touches: [], dependsOn: [] });
  registry.close(c.id);
  const cClosedAt = registry.get(c.id)!.closedAt;
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: [], dependsOn: [], groupId: c.id });
  const b = registry.register({ projectId: "p2", developerId: "d2", sessionId: "s2", summary: "", creates: [], touches: [], dependsOn: [], groupId: c.id });

  registry.close(a.id);

  assert.equal(registry.get(a.id)?.status, "closed");
  assert.equal(registry.get(b.id)?.status, "closed", "open sibling in a different project also closes");
  assert.equal(registry.get(c.id)?.status, "closed");
  assert.equal(registry.get(c.id)?.closedAt, cClosedAt, "already-closed sibling's closedAt is not re-stamped");
  registry.stop();
});

test("DesignRegistry: close's sibling fan-out logs a design_closed event with propagatedFrom* payload", () => {
  const db = createDb({ memory: true });
  const log = new DrizzleActivityLog(db);
  const registry = new DesignRegistry(db);
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: [], dependsOn: [] });
  const b = registry.register({ projectId: "p2", developerId: "d2", sessionId: "s2", summary: "", creates: [], touches: [], dependsOn: [], groupId: a.groupId });

  registry.close(a.id);

  const events = log.eventsForRelatedId(b.id).filter((e) => e.kind === "design_closed");
  assert.equal(events.length, 1);
  assert.equal((events[0].payload as { propagatedFromDesignId?: string }).propagatedFromDesignId, a.id);
  assert.equal((events[0].payload as { propagatedFromGroupId?: string }).propagatedFromGroupId, a.groupId);
  registry.stop();
});

test("ConstraintStore: add is idempotent per (projectId, statement) and persists across instances", () => {
  const dataDir = tmpDataDir();
  const store1 = new ConstraintStore(createDb({ dataDir }));
  const c1 = store1.add("p1", "use pkg/retry", ["src/**"], "constraint", "seeded");
  const c2 = store1.add("p1", "use pkg/retry", ["src/**"], "constraint", "seeded");
  assert.equal(c1.id, c2.id);

  const store2 = new ConstraintStore(createDb({ dataDir }));
  assert.equal(store2.forProject("p1").length, 1);
});

// 2026-08-26: this test used to also cover a "type change on an existing
// statement match" sub-case (`add`'s scope/type-update fix, 2026-08-16) --
// dropped, not just renamed, since `DesignConstraintType` collapsed to a
// single value ("constraint") the same day, so there's no second value left
// to change *to*. The scope-update half of that same fix is still real
// behavior and still covered below.
test("ConstraintStore: add updates scope on an existing statement match instead of ignoring the change (2026-08-16 fix)", () => {
  const store = new ConstraintStore(createDb({ dataDir: tmpDataDir() }));
  const original = store.add("p1", "use pkg/retry", ["packages/**"], "constraint", "seeded");

  // Re-seeding the same statement with a narrower scope -- before the fix,
  // this silently returned the stale packages/** row unchanged.
  const narrowed = store.add("p1", "use pkg/retry", ["packages/core/src/retry.ts"], "constraint", "seeded");
  assert.equal(narrowed.id, original.id, "same constraint identity, not a duplicate row");
  assert.deepEqual(narrowed.scope, ["packages/core/src/retry.ts"]);
  assert.equal(store.forProject("p1").length, 1, "still exactly one row, updated in place");

  // A no-op re-seed (identical scope and type) doesn't append a redundant update.
  const unchanged = store.add("p1", "use pkg/retry", ["packages/core/src/retry.ts"], "constraint", "seeded");
  assert.equal(unchanged.id, narrowed.id);
});

test("ConstraintStore: get finds by id, remove deletes and logs constraint_removed, both are no-ops on an unknown id", () => {
  const dataDir = tmpDataDir();
  const activityLog = new DrizzleActivityLog(createDb({ dataDir }));
  const store = new ConstraintStore(createDb({ dataDir }), { activityLog });
  const created = store.add("p1", "use pkg/retry", ["src/**"], "constraint", "seeded");

  assert.deepEqual(store.get(created.id), created);
  assert.equal(store.get("no-such-id"), undefined);

  const removed = store.remove(created.id);
  assert.deepEqual(removed, created);
  assert.equal(store.get(created.id), undefined, "gone from forProject/get after removal");
  assert.equal(store.forProject("p1").length, 0);

  assert.equal(activityLog.eventsForRelatedId(created.id).filter((e) => e.kind === "constraint_removed").length, 1);

  // Removing again (or an id that never existed) is a safe no-op, not a throw.
  assert.equal(store.remove(created.id), undefined);
  assert.equal(store.remove("never-existed"), undefined);
});

test("DesignRegistry: listByProjectPage paginates newest-first with a rowid tiebreak, nextBefore only when more remain", async () => {
  const registry = freshRegistry();
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    ids.push(registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: `d${i}`, creates: [], touches: [], dependsOn: [] }).id);
    // A tight loop can register several rows within the same millisecond,
    // and `before` (an exclusive bound on that shared `createdAt`) would
    // then drop *all* same-millisecond rows at once, not just the ones
    // already returned -- the same accepted tie gap `eventsForProjectPage`
    // documents (activity-log.ts). A real page boundary needs distinct
    // `createdAt` values to actually test the cursor, hence the delay.
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  ids.reverse(); // newest-first is registration order reversed

  const page1 = registry.listByProjectPage("p1", { limit: 2 });
  assert.deepEqual(
    page1.items.map((d) => d.id),
    ids.slice(0, 2),
  );
  assert.ok(page1.nextBefore !== undefined, "more rows remain -- nextBefore must be present");

  const page2 = registry.listByProjectPage("p1", { limit: 2, before: page1.nextBefore });
  assert.deepEqual(
    page2.items.map((d) => d.id),
    ids.slice(2, 4),
  );
  assert.ok(page2.nextBefore !== undefined);

  const page3 = registry.listByProjectPage("p1", { limit: 2, before: page2.nextBefore });
  assert.deepEqual(
    page3.items.map((d) => d.id),
    ids.slice(4, 5),
  );
  assert.equal(page3.nextBefore, undefined, "last page must not carry a cursor");

  // Concatenating every page reproduces the full unpaginated list exactly.
  assert.deepEqual(
    [...page1.items, ...page2.items, ...page3.items].map((d) => d.id),
    registry.listByProject("p1").map((d) => d.id),
  );
  registry.stop();
});

test("DesignRegistry: listByProjectPage composes status/sessionId/developerId filters with pagination", () => {
  const registry = freshRegistry();
  registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "a", creates: [], touches: [], dependsOn: [] });
  const b = registry.register({ projectId: "p1", developerId: "d2", sessionId: "s2", summary: "b", creates: [], touches: [], dependsOn: [] });
  registry.close(b.id);
  registry.register({ projectId: "p2", developerId: "d1", sessionId: "s3", summary: "wrong project", creates: [], touches: [], dependsOn: [] });

  assert.deepEqual(
    registry.listByProjectPage("p1", { developerId: "d1" }).items.map((d) => d.summary),
    ["a"],
  );
  assert.deepEqual(
    registry.listByProjectPage("p1", { status: "closed" }).items.map((d) => d.summary),
    ["b"],
  );
  assert.deepEqual(
    registry.listByProjectPage("p1", { sessionId: "s2" }).items.map((d) => d.summary),
    ["b"],
  );
  registry.stop();
});

test("DesignRegistry: listByProjectPage clamps limit to the 100-row cap and defaults to 20", () => {
  const registry = freshRegistry();
  for (let i = 0; i < 25; i++) {
    registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: `d${i}`, creates: [], touches: [], dependsOn: [] });
  }
  assert.equal(registry.listByProjectPage("p1").items.length, 20, "default limit is 20");
  assert.equal(registry.listByProjectPage("p1", { limit: 500 }).items.length, 25, "clamped to 100 cap, but only 25 rows exist");
  registry.stop();
});

test("DesignRegistry: listReviewsPage paginates and composes with the pending/decided/all filter", () => {
  const registry = freshRegistry();
  const designId = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: [], dependsOn: [] }).id;
  const r1 = registry.addReview(designId, "p1", "first");
  const r2 = registry.addReview(designId, "p1", "second");
  const r3 = registry.addReview(designId, "p1", "third");
  registry.decideReview(r2.id, "approve");

  const pending = registry.listReviewsPage("p1", { filter: "pending", limit: 2 });
  assert.deepEqual(
    pending.items.map((r) => r.id),
    [r3.id, r1.id],
  );
  assert.equal(pending.nextBefore, undefined, "only 2 pending reviews exist -- no further page");

  const decided = registry.listReviewsPage("p1", { filter: "decided" });
  assert.deepEqual(
    decided.items.map((r) => r.id),
    [r2.id],
  );

  const all = registry.listReviewsPage("p1", { filter: "all", limit: 1 });
  assert.equal(all.items.length, 1);
  assert.ok(all.nextBefore !== undefined);
  registry.stop();
});
