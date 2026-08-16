import { test } from "node:test";
import assert from "node:assert/strict";
import { createDb } from "./db/client.js";
import { DrizzleActivityLog } from "./activity-log.js";

function freshLog() {
  const db = createDb({ memory: true });
  return new DrizzleActivityLog(db);
}

test("DrizzleActivityLog: append assigns an id and round-trips a JSON payload", () => {
  const log = freshLog();
  const event = log.append({ projectId: "p1", kind: "claim_recorded", relatedId: "sym1", ts: 100, payload: { symbolId: "sym1", kind: "write" } });
  assert.ok(event.id);
  const [back] = log.eventsForRelatedId("sym1");
  assert.deepEqual(back.payload, { symbolId: "sym1", kind: "write" });
});

test("DrizzleActivityLog: eventsForRelatedId returns only matching events, ordered by ts", () => {
  const log = freshLog();
  log.append({ projectId: "p1", kind: "alignment_thread_opened", relatedId: "thread1", ts: 200 });
  log.append({ projectId: "p1", kind: "alignment_message_posted", relatedId: "thread1", ts: 100 });
  log.append({ projectId: "p1", kind: "alignment_message_posted", relatedId: "other-thread", ts: 150 });

  const events = log.eventsForRelatedId("thread1");
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.ts), [100, 200], "should be ordered oldest first");
});

test("DrizzleActivityLog: eventsForProject filters by projectId and optional since", () => {
  const log = freshLog();
  log.append({ projectId: "p1", kind: "design_registered", relatedId: "d1", ts: 100 });
  log.append({ projectId: "p1", kind: "design_closed", relatedId: "d1", ts: 200 });
  log.append({ projectId: "p2", kind: "design_registered", relatedId: "d2", ts: 100 });

  assert.equal(log.eventsForProject("p1").length, 2);
  assert.equal(log.eventsForProject("p1", 100).length, 1, "since is exclusive");
  assert.equal(log.eventsForProject("p2").length, 1);
});

test("DrizzleActivityLog: developerId/sessionId/relatedId are optional and round-trip as undefined, not null", () => {
  const log = freshLog();
  log.append({ projectId: "p1", kind: "design_expired", ts: 100 });
  const [event] = log.eventsForProject("p1");
  assert.equal(event.developerId, undefined);
  assert.equal(event.sessionId, undefined);
  assert.equal(event.relatedId, undefined);
  assert.equal(event.payload, undefined);
});
