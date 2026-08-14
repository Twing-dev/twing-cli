import { test } from "node:test";
import assert from "node:assert/strict";
import { createDb } from "./db/client.js";
import { AlignmentThreadStore } from "./alignment-store.js";

function freshStore() {
  return new AlignmentThreadStore(createDb({ memory: true }));
}

const baseInput = {
  projectId: "p1",
  symbolId: "src/net/retry.ts::RetryPolicy.backoff",
  developerId: "alice",
  otherDeveloperId: "bob",
  designId: "d1",
  systemDescription: "alice's edit falls inside bob's open design",
};

test("AlignmentThreadStore: findOrCreate opens a new thread and seeds it with the system description as the first message", () => {
  const store = freshStore();
  const thread = store.findOrCreate(baseInput);
  assert.equal(thread.status, "open");
  const messages = store.messages(thread.id);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].message, baseInput.systemDescription);
  assert.equal(messages[0].authorId, undefined, "the system seed message has no author");
});

test("AlignmentThreadStore: findOrCreate dedups a repeat detection of the same open divergence", () => {
  const store = freshStore();
  const first = store.findOrCreate(baseInput);
  const second = store.findOrCreate(baseInput);
  assert.equal(first.id, second.id);
  assert.equal(store.messages(first.id).length, 1, "should not seed a second system message");
});

test("AlignmentThreadStore: findOrCreate opens a new thread once the prior one is closed", () => {
  const store = freshStore();
  const first = store.findOrCreate(baseInput);
  store.close(first.id, "alice");
  const second = store.findOrCreate(baseInput);
  assert.notEqual(first.id, second.id);
});

test("AlignmentThreadStore: listByProject filters by status", () => {
  const store = freshStore();
  const open = store.findOrCreate(baseInput);
  const toClose = store.findOrCreate({ ...baseInput, symbolId: "other.ts" });
  store.close(toClose.id, "alice");

  assert.equal(store.listByProject("p1", "open").length, 1);
  assert.equal(store.listByProject("p1", "open")[0].id, open.id);
  assert.equal(store.listByProject("p1", "closed").length, 1);
  assert.equal(store.listByProject("p1").length, 2);
});

test("AlignmentThreadStore: postMessage requires an existing thread", () => {
  const store = freshStore();
  assert.equal(store.postMessage("no-such-thread", "alice", "hi"), undefined);
});

test("AlignmentThreadStore: postMessage appends to the thread's message history in order", () => {
  const store = freshStore();
  const thread = store.findOrCreate(baseInput);
  store.postMessage(thread.id, "bob", "ack, I'll rename mine");
  store.postMessage(thread.id, "alice", "sounds good");

  const messages = store.messages(thread.id);
  assert.equal(messages.length, 3);
  assert.equal(messages[1].authorId, "bob");
  assert.equal(messages[1].message, "ack, I'll rename mine");
  assert.equal(messages[2].authorId, "alice");
});

test("AlignmentThreadStore: close is idempotent -- closing twice doesn't double-log", () => {
  const store = freshStore();
  const thread = store.findOrCreate(baseInput);
  store.close(thread.id, "alice");
  store.close(thread.id, "bob"); // second close, different closer -- must be a no-op
  const closed = store.get(thread.id);
  assert.equal(closed?.status, "closed");
  assert.equal(closed?.closedBy, "alice", "the first close wins; a second close must not overwrite it");
});

test("AlignmentThreadStore: close returns undefined for an unknown thread", () => {
  const store = freshStore();
  assert.equal(store.close("no-such-thread", "alice"), undefined);
});
