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
  const flagged = registry.flag(a.id, "overlap");
  assert.equal(flagged?.status, "flagged");
  const events = log.eventsForRelatedId(a.id).filter((e) => e.kind === "design_flagged");
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].payload, { verdict: "overlap", summary: "retry helper" });
  registry.stop();
});

test("DesignRegistry: flag's optional detail persists the full conflicts/constraint onto the event, not just the bare verdict", () => {
  const db = createDb({ memory: true });
  const log = new DrizzleActivityLog(db);
  const registry = new DesignRegistry(db);
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "retry helper", creates: [], touches: [], dependsOn: [] });

  const conflicts = [{ conflictingDesignId: "other-id", overlapKind: "touches" as const, overlapDetail: "both touch a.ts", conflictingSummary: "other design", overlapPaths: ["a.ts"] }];
  registry.flag(a.id, "overlap", { conflicts });
  const events = log.eventsForRelatedId(a.id).filter((e) => e.kind === "design_flagged");
  assert.deepEqual(events[0].payload, { verdict: "overlap", summary: "retry helper", conflicts });
  registry.stop();
});

test("DesignRegistry: flag's optional detail persists a constraint match, and omits an empty conflicts array rather than logging []", () => {
  const db = createDb({ memory: true });
  const log = new DrizzleActivityLog(db);
  const registry = new DesignRegistry(db);
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "retry helper", creates: [], touches: [], dependsOn: [] });

  const constraint = { id: "c1", statement: "use pkg/retry", type: "canonical_abstraction" as const };
  registry.flag(a.id, "constraint_flag", { conflicts: [], constraints: [constraint] });
  const events = log.eventsForRelatedId(a.id).filter((e) => e.kind === "design_flagged");
  assert.deepEqual(events[0].payload, { verdict: "constraint_flag", summary: "retry helper", constraints: [constraint] });
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
  registry.flag(a.id, "overlap");
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
  registry.flag(a.id, "overlap");
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
  registry.flag(a.id, "overlap"); // a candidate the caller found via openPlanModeDesignForSession may be flagged

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

test("ConstraintStore: add is idempotent per (projectId, statement) and persists across instances", () => {
  const dataDir = tmpDataDir();
  const store1 = new ConstraintStore(createDb({ dataDir }));
  const c1 = store1.add("p1", "use pkg/retry", ["src/**"], "canonical_abstraction", "seeded");
  const c2 = store1.add("p1", "use pkg/retry", ["src/**"], "canonical_abstraction", "seeded");
  assert.equal(c1.id, c2.id);

  const store2 = new ConstraintStore(createDb({ dataDir }));
  assert.equal(store2.forProject("p1").length, 1);
});

test("ConstraintStore: add updates scope/type on an existing statement match instead of ignoring the change (2026-08-16 fix)", () => {
  const store = new ConstraintStore(createDb({ dataDir: tmpDataDir() }));
  const original = store.add("p1", "use pkg/retry", ["packages/**"], "canonical_abstraction", "seeded");

  // Re-seeding the same statement with a narrower scope -- before the fix,
  // this silently returned the stale packages/** row unchanged.
  const narrowed = store.add("p1", "use pkg/retry", ["packages/core/src/retry.ts"], "canonical_abstraction", "seeded");
  assert.equal(narrowed.id, original.id, "same constraint identity, not a duplicate row");
  assert.deepEqual(narrowed.scope, ["packages/core/src/retry.ts"]);
  assert.equal(store.forProject("p1").length, 1, "still exactly one row, updated in place");

  // A type change on the same statement also applies.
  const retyped = store.add("p1", "use pkg/retry", ["packages/core/src/retry.ts"], "review_required", "seeded");
  assert.equal(retyped.type, "review_required");

  // A no-op re-seed (identical scope and type) doesn't append a redundant update.
  const unchanged = store.add("p1", "use pkg/retry", ["packages/core/src/retry.ts"], "review_required", "seeded");
  assert.equal(unchanged.id, retyped.id);
});

test("ConstraintStore: get finds by id, remove deletes and logs constraint_removed, both are no-ops on an unknown id", () => {
  const dataDir = tmpDataDir();
  const activityLog = new DrizzleActivityLog(createDb({ dataDir }));
  const store = new ConstraintStore(createDb({ dataDir }), { activityLog });
  const created = store.add("p1", "use pkg/retry", ["src/**"], "canonical_abstraction", "seeded");

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
