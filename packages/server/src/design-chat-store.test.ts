/**
 * `DesignChatStore`. One property carries all the weight: a reviewer's thread
 * is theirs. Everything else here is bookkeeping around that.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createDb, type Db } from "./db/client.js";
import { DesignChatStore } from "./design-chat-store.js";
import { DrizzleActivityLog } from "./activity-log.js";

function freshStore(): { store: DesignChatStore; db: Db } {
  const db = createDb({ memory: true });
  return { store: new DesignChatStore(db), db };
}

const base = { projectId: "p1", designId: "d1" };

test("DesignChatStore: a reviewer's second question continues their thread rather than forking one", () => {
  const { store } = freshStore();
  const first = store.findOrCreate({ ...base, reviewerId: "alice@example.com" });
  const second = store.findOrCreate({ ...base, reviewerId: "alice@example.com" });
  // Without this, follow-ups would not work at all: each question would open
  // a conversation with no memory of the last.
  assert.equal(first.id, second.id);
});

// The whole point of a separate store from `designComments`.
test("DesignChatStore: two reviewers on one design get separate threads", () => {
  const { store } = freshStore();
  const alice = store.findOrCreate({ ...base, reviewerId: "alice@example.com" });
  const bob = store.findOrCreate({ ...base, reviewerId: "bob@example.com" });
  assert.notEqual(alice.id, bob.id);

  store.append(alice.id, { role: "reviewer", message: "half-formed thought I would rather not publish", ts: 0 });
  assert.deepEqual(store.messages(bob.id), [], "bob's thread is empty, and stays that way");
  assert.equal(store.messages(alice.id).length, 1);
});

test("DesignChatStore: find is scoped to the asking reviewer, so there is no id to guess at", () => {
  const { store } = freshStore();
  store.findOrCreate({ ...base, reviewerId: "alice@example.com" });
  assert.equal(store.find("d1", "bob@example.com"), undefined);
});

test("DesignChatStore: messages come back oldest-first with their role and provenance", () => {
  const { store } = freshStore();
  const chat = store.findOrCreate({ ...base, reviewerId: "alice@example.com" });
  store.append(chat.id, { role: "reviewer", message: "why 30s?", ts: 0 });
  store.append(chat.id, { role: "agent", message: "the gateway gives up at 31s", ts: 0, provenance: "Grounded in 12 of 40 turns." });

  const messages = store.messages(chat.id);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "reviewer");
  assert.equal(messages[1].role, "agent");
  assert.equal(messages[1].provenance, "Grounded in 12 of 40 turns.");
  assert.equal(messages[0].provenance, undefined, "a reviewer's own turn is not grounded in anything");
});

// The failure that matters is a model's words being taken for a person's, so
// anything unrecognised reads as the agent.
test("DesignChatStore: an unrecognised role reads as the agent, never as the reviewer", () => {
  const { store, db } = freshStore();
  const chat = store.findOrCreate({ ...base, reviewerId: "alice@example.com" });
  new DrizzleActivityLog(db).append({
    projectId: "p1",
    kind: "design_chat_message",
    relatedId: chat.id,
    ts: Date.now(),
    payload: { role: "something-else", message: "unclear provenance" },
  });
  assert.equal(store.messages(chat.id)[0].role, "agent");
});

test("DesignChatStore: appending to a thread that does not exist is undefined, not a throw", () => {
  const { store } = freshStore();
  assert.equal(store.append("nope", { role: "reviewer", message: "x", ts: 0 }), undefined);
});

test("DesignChatStore: lastActivityAt moves with the conversation", () => {
  const { store } = freshStore();
  const chat = store.findOrCreate({ ...base, reviewerId: "alice@example.com" });
  const before = store.get(chat.id)!.lastActivityAt;
  store.append(chat.id, { role: "reviewer", message: "x", ts: 0 });
  assert.ok(store.get(chat.id)!.lastActivityAt >= before);
});

// The most an admin gets. "Who is unsure about my design" is a chilling
// thing to publish and nobody needs it to run a project.
test("DesignChatStore: countForDesign reports how many threads exist, never whose", () => {
  const { store } = freshStore();
  store.findOrCreate({ ...base, reviewerId: "alice@example.com" });
  store.findOrCreate({ ...base, reviewerId: "bob@example.com" });
  store.findOrCreate({ ...base, designId: "d2", reviewerId: "alice@example.com" });

  assert.equal(store.countForDesign("d1"), 2);
  assert.equal(store.countForDesign("d2"), 1);
  assert.equal(store.countForDesign("d3"), 0);
});

test("DesignChatStore: listForReviewer never returns another reviewer's threads", () => {
  const { store } = freshStore();
  store.findOrCreate({ ...base, reviewerId: "alice@example.com" });
  store.findOrCreate({ ...base, designId: "d2", reviewerId: "alice@example.com" });
  store.findOrCreate({ ...base, designId: "d3", reviewerId: "bob@example.com" });

  const mine = store.listForReviewer("p1", "alice@example.com");
  assert.deepEqual(mine.map((c) => c.designId).sort(), ["d1", "d2"]);
});

// Chats ride the shared activity log, which is otherwise a project's
// readable history. If they showed up in the project feed, the whole privacy
// model would be decoration -- see PRIVATE_EVENT_KINDS in activity-log.ts.
test("DesignChatStore: chat messages never appear in the project's activity feed", () => {
  const { store, db } = freshStore();
  const log = new DrizzleActivityLog(db);
  const chat = store.findOrCreate({ ...base, reviewerId: "alice@example.com" });
  store.append(chat.id, { role: "reviewer", message: "a private half-formed thought", ts: 0 });
  log.append({ projectId: "p1", kind: "design_registered", relatedId: "d1", ts: Date.now(), payload: {} });

  const feed = log.eventsForProjectPage("p1", {});
  assert.deepEqual(
    feed.items.map((e) => e.kind),
    ["design_registered"],
  );

  // And not reachable by asking for them directly, either -- `kinds` and
  // `relatedId` are both caller-supplied.
  assert.deepEqual(log.eventsForProjectPage("p1", { kinds: ["design_chat_message"] }).items, []);
  assert.deepEqual(log.eventsForProjectPage("p1", { relatedId: chat.id }).items, []);
});
