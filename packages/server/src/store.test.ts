import { test } from "node:test";
import assert from "node:assert/strict";
import type { Claim } from "@twing/core";
import { createDb } from "./db/client.js";
import { Store } from "./store.js";
import type { ActivityEvent, ActivityLogWriter } from "./activity-log.js";

class StubActivityLog implements ActivityLogWriter {
  events: Omit<ActivityEvent, "id">[] = [];
  append(event: Omit<ActivityEvent, "id">): ActivityEvent {
    this.events.push(event);
    return { ...event, id: `stub-${this.events.length}` };
  }
}

function freshStore() {
  const db = createDb({ memory: true });
  const activityLog = new StubActivityLog();
  const store = new Store(db, { activityLog });
  return { store, activityLog };
}

function makeClaim(overrides: Partial<Claim> = {}): Claim {
  return {
    projectId: "p1",
    developerId: "alice",
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

test("Store: upsert refreshes the same symbol+session in place rather than duplicating", () => {
  const { store } = freshStore();
  const claim = makeClaim();
  store.upsert("p1", [claim], []);
  store.upsert("p1", [{ ...claim, ts: claim.ts + 1000 }], []);
  assert.equal(store.activeClaims("p1").length, 1);
});

test("Store: upsert returns only new/changed claims", () => {
  const { store } = freshStore();
  const claim = makeClaim();
  const first = store.upsert("p1", [claim], []);
  assert.equal(first.length, 1);
  const second = store.upsert("p1", [claim], []); // identical ts -- unchanged
  assert.equal(second.length, 0);
  const third = store.upsert("p1", [{ ...claim, ts: claim.ts + 1 }], []);
  assert.equal(third.length, 1);
});

test("Store: activeClaims excludes expired claims", () => {
  const { store } = freshStore();
  const now = Date.now();
  store.upsert("p1", [makeClaim({ ts: now - 10_000, ttlMs: 1000 })], []);
  assert.equal(store.activeClaims("p1", now).length, 0);
});

test("Store: callEdgesFor dedups by caller->callee", () => {
  const { store } = freshStore();
  const edge = { projectId: "p1", callerSymbolId: "a", calleeSymbolId: "b" };
  store.upsert("p1", [], [edge, edge]);
  store.upsert("p1", [], [edge]);
  assert.equal(store.callEdgesFor("p1").length, 1);
});

test("Store: addNotice/noticesSince round-trips threadId and filters by since", () => {
  const { store } = freshStore();
  store.addNotice("alice", "you and bob are both touching X", 100, "thread-1");
  store.addNotice("alice", "an earlier notice", 50);
  const notices = store.noticesSince("alice", 60);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].message, "you and bob are both touching X");
  assert.equal(notices[0].threadId, "thread-1");
});

test("Store: addNotice without threadId round-trips as undefined", () => {
  const { store } = freshStore();
  store.addNotice("alice", "plain finding", 100);
  const [notice] = store.noticesSince("alice", 0);
  assert.equal(notice.threadId, undefined);
});

test("Store: upsert appends exactly one claim_recorded activity event per changed claim", () => {
  const { store, activityLog } = freshStore();
  const claim = makeClaim();
  store.upsert("p1", [claim], []);
  assert.equal(activityLog.events.length, 1);
  assert.equal(activityLog.events[0].kind, "claim_recorded");
  assert.equal(activityLog.events[0].relatedId, claim.symbolId);

  store.upsert("p1", [claim], []); // unchanged -- no new event
  assert.equal(activityLog.events.length, 1);
});

test("Store: upsert appends one call_edge_recorded event per new edge, none for duplicates", () => {
  const { store, activityLog } = freshStore();
  const edge = { projectId: "p1", callerSymbolId: "a", calleeSymbolId: "b" };
  store.upsert("p1", [], [edge]);
  store.upsert("p1", [], [edge]);
  const edgeEvents = activityLog.events.filter((e) => e.kind === "call_edge_recorded");
  assert.equal(edgeEvents.length, 1);
});
