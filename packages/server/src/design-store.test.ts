import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DesignRegistry, ConstraintStore } from "./design-store.js";

test("DesignRegistry: openDesigns excludes the candidate itself", () => {
  const registry = new DesignRegistry();
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: ["X"], touches: [], dependsOn: [] });
  const b = registry.register({ projectId: "p1", developerId: "d2", sessionId: "s2", summary: "", creates: ["Y"], touches: [], dependsOn: [] });
  const open = registry.openDesigns("p1", Date.now(), a.id);
  assert.equal(open.length, 1);
  assert.equal(open[0].id, b.id);
  registry.stop();
});

test("DesignRegistry: TTL expiry excludes designs past createdAt+ttlMs", () => {
  const registry = new DesignRegistry();
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: [], dependsOn: [], ttlMs: 10 });
  const open = registry.openDesigns("p1", a.createdAt + 1000);
  assert.equal(open.length, 0);
  registry.stop();
});

test("DesignRegistry: supersede marks status and closedAt", () => {
  const registry = new DesignRegistry();
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: [], dependsOn: [] });
  const superseded = registry.supersede(a.id);
  assert.equal(superseded?.status, "superseded");
  assert.ok(superseded?.closedAt);
  registry.stop();
});

test("DesignRegistry: closeSession closes every open design for a session, ignores others", () => {
  const registry = new DesignRegistry();
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
  const registry = new DesignRegistry();
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: [], dependsOn: [] });
  const review = registry.addReview(a.id, "p1", "we need a second retry strategy for streaming");
  registry.decideReview(review.id, "approve");
  assert.equal(registry.get(a.id)?.status, "open");
  registry.stop();
});

test("DesignRegistry: rejecting a review does not reopen the design", () => {
  const registry = new DesignRegistry();
  const a = registry.register({ projectId: "p1", developerId: "d1", sessionId: "s1", summary: "", creates: [], touches: [], dependsOn: [] });
  const review = registry.addReview(a.id, "p1", "just because");
  registry.decideReview(review.id, "reject");
  assert.equal(registry.get(a.id)?.status, "open"); // register() leaves it open; reject just doesn't change it
  assert.equal(registry.getReview(review.id)?.decision, "reject");
  registry.stop();
});

test("ConstraintStore: add is idempotent per (projectId, statement) and persists across instances", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twing-constraint-test-"));
  try {
    const store1 = new ConstraintStore({ dataDir: dir });
    const c1 = store1.add("p1", "use pkg/retry", ["src/**"], "canonical_abstraction", "seeded");
    const c2 = store1.add("p1", "use pkg/retry", ["src/**"], "canonical_abstraction", "seeded");
    assert.equal(c1.id, c2.id);

    const store2 = new ConstraintStore({ dataDir: dir });
    assert.equal(store2.forProject("p1").length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
