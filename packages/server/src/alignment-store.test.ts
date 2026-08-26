import { test } from "node:test";
import assert from "node:assert/strict";
import { createDb, type Db } from "./db/client.js";
import { alignmentThreads as threadsTable } from "./db/schema.js";
import { AlignmentThreadStore, buildAlignmentSummary } from "./alignment-store.js";

function freshStore(): { store: AlignmentThreadStore; db: Db } {
  const db = createDb({ memory: true });
  return { store: new AlignmentThreadStore(db), db };
}

const baseInput = {
  projectId: "p1",
  symbolIds: ["src/net/retry.ts::RetryPolicy.backoff"],
  developerId: "alice",
  otherDeveloperId: "bob",
  designId: "d1",
  systemDescription: "alice's edit falls inside bob's open design",
  category: "symbol_conflict" as const,
  subKind: "scope_intrusion" as const,
  summary: "1 overlapping path with \"bob's design\"",
  initiatingDesignId: "alice-design-1",
};

test("AlignmentThreadStore: findOrCreate opens a new thread and seeds it with the system description as the first message", () => {
  const { store } = freshStore();
  const thread = store.findOrCreate(baseInput);
  assert.equal(thread.status, "open");
  assert.equal(thread.category, "symbol_conflict");
  assert.equal(thread.summary, baseInput.summary);
  assert.deepEqual(thread.symbolIds, baseInput.symbolIds);
  assert.equal(thread.initiatingDesignId, "alice-design-1");
  assert.equal(thread.lastActivityAt, thread.openedAt);
  const messages = store.messages(thread.id);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].message, baseInput.systemDescription);
  assert.equal(messages[0].authorId, undefined, "the system seed message has no author");
});

test("AlignmentThreadStore: findOrCreate dedups a repeat detection of the same open divergence -- no new message when nothing new is being said", () => {
  const { store } = freshStore();
  const first = store.findOrCreate(baseInput);
  const second = store.findOrCreate(baseInput);
  assert.equal(first.id, second.id);
  assert.equal(store.messages(first.id).length, 1, "should not seed a second system message");
});

test("AlignmentThreadStore: a new overlapping symbol amends the existing open thread instead of forking a new one", () => {
  const { store } = freshStore();
  const first = store.findOrCreate(baseInput);
  const second = store.findOrCreate({ ...baseInput, symbolIds: ["src/net/retry.test.ts"], systemDescription: "also touched the test file" });

  assert.equal(first.id, second.id, "same developer pair + target design -- must amend, not fork");
  assert.deepEqual(second.symbolIds.sort(), ["src/net/retry.test.ts", "src/net/retry.ts::RetryPolicy.backoff"]);
  assert.ok(second.lastActivityAt >= first.lastActivityAt);

  const messages = store.messages(first.id);
  assert.equal(messages.length, 2, "a genuinely new symbol is worth a follow-up message");
  assert.equal(messages[1].message, "also touched the test file");
});

test("AlignmentThreadStore: a semantic-conflict re-check always posts a follow-up message, even with no new symbols", () => {
  const { store } = freshStore();
  const semanticInput = { ...baseInput, category: "llm_divergence" as const, subKind: "tension" as const, symbolIds: [], systemDescription: "first tension finding" };
  const first = store.findOrCreate(semanticInput);
  const second = store.findOrCreate({ ...semanticInput, systemDescription: "re-checked after an amend, still tension" });

  assert.equal(first.id, second.id);
  const messages = store.messages(first.id);
  assert.equal(messages.length, 2, "every semantic-conflict finding is fresh, unlike a repeated symbol_conflict");
  assert.equal(messages[1].message, "re-checked after an amend, still tension");
});

test("AlignmentThreadStore: initiatingDesignId is set once resolved and never cleared by a later amend that can't resolve it", () => {
  const { store } = freshStore();
  const first = store.findOrCreate(baseInput);
  assert.equal(first.initiatingDesignId, "alice-design-1");

  const second = store.findOrCreate({ ...baseInput, symbolIds: ["src/other.ts"], initiatingDesignId: undefined });
  assert.equal(second.initiatingDesignId, "alice-design-1", "must not regress from known to unknown");
});

// Found live (2026-08-26): llm_divergence's one-directional detection
// (runSemanticComparatorPass only ever checks the *current* design being
// registered/amended against everything else open) meant the reverse
// direction -- the other developer's own later registration getting
// checked against *this* design -- never recognized it as the same
// underlying tension, and forked a second thread for what was one
// disagreement between one pair of designs.
test("AlignmentThreadStore: findOrCreate reuses the same llm_divergence thread when the reverse direction reports the same design pair", () => {
  const { store } = freshStore();
  const semanticInput = {
    ...baseInput,
    category: "llm_divergence" as const,
    subKind: "tension" as const,
    symbolIds: [],
    designId: "bobs-design", // the *other* design, from alice's point of view
    initiatingDesignId: "alices-design", // alice's own design, the one flagged here
    systemDescription: "alice's registration found tension with bob's open design",
  };
  const first = store.findOrCreate(semanticInput);
  assert.equal(first.initiatingDesignId, "alices-design");
  assert.equal(first.designId, "bobs-design");

  // Bob's own registration later triggers its own one-directional check
  // against alice's design -- developerId/otherDeveloperId reversed, and
  // designId/initiatingDesignId swapped to match (bob's designId is now
  // "the other design", alice's; bob's initiatingDesignId is his own).
  const reverseInput = {
    ...semanticInput,
    developerId: "bob",
    otherDeveloperId: "alice",
    designId: "alices-design",
    initiatingDesignId: "bobs-design",
    systemDescription: "bob's registration found the same tension with alice's design",
  };
  const second = store.findOrCreate(reverseInput);

  assert.equal(second.id, first.id, "must reuse the one existing thread, not fork a second one for the reverse direction");
  assert.equal(second.initiatingDesignId, "alices-design", "must not regress the already-known initiator");
  assert.equal(second.designId, "bobs-design", "designId is set at creation and never touched by amend");

  const messages = store.messages(first.id);
  assert.equal(messages.length, 2, "bob's own finding is still worth a follow-up message in the shared thread");
  assert.equal(messages[1].message, "bob's registration found the same tension with alice's design");
});

// A genuinely different pair (or a pair that doesn't fully match on both
// design ids) must not accidentally merge into someone else's thread --
// the reverse match requires *both* initiatingDesignId and designId to
// line up, not just the developer pair.
test("AlignmentThreadStore: the reverse-direction match requires both design ids to line up, not just the developer pair", () => {
  const { store } = freshStore();
  const semanticInput = {
    ...baseInput,
    category: "llm_divergence" as const,
    subKind: "tension" as const,
    symbolIds: [],
    designId: "bobs-design",
    initiatingDesignId: "alices-design",
  };
  const first = store.findOrCreate(semanticInput);

  // Same developer pair (reversed), but bob's own design here is a
  // *different* one than the thread already knows about -- a genuinely
  // separate, unrelated tension between the same two people.
  const unrelated = store.findOrCreate({
    ...semanticInput,
    developerId: "bob",
    otherDeveloperId: "alice",
    designId: "alices-design",
    initiatingDesignId: "bobs-other-design",
    systemDescription: "an unrelated tension",
  });

  assert.notEqual(unrelated.id, first.id, "must not merge into a thread about a different design of bob's");
});

test("AlignmentThreadStore: findOrCreate opens a new thread once the prior one is closed", () => {
  const { store } = freshStore();
  const first = store.findOrCreate(baseInput);
  store.close(first.id, "alice");
  const second = store.findOrCreate(baseInput);
  assert.notEqual(first.id, second.id);
});

test("AlignmentThreadStore: listByProject filters by status", () => {
  const { store } = freshStore();
  const open = store.findOrCreate(baseInput);
  // A genuinely unrelated divergence (different otherDeveloperId), not just a
  // different symbol -- same pair/design now amends instead of forking.
  const toClose = store.findOrCreate({ ...baseInput, otherDeveloperId: "carol" });
  store.close(toClose.id, "alice");

  assert.equal(store.listByProject("p1", "open").length, 1);
  assert.equal(store.listByProject("p1", "open")[0].id, open.id);
  assert.equal(store.listByProject("p1", "closed").length, 1);
  assert.equal(store.listByProject("p1").length, 2);
});

test("AlignmentThreadStore: postMessage requires an existing thread", () => {
  const { store } = freshStore();
  assert.equal(store.postMessage("no-such-thread", "alice", "hi"), undefined);
});

test("AlignmentThreadStore: postMessage appends to the thread's message history in order", () => {
  const { store } = freshStore();
  const thread = store.findOrCreate(baseInput);
  store.postMessage(thread.id, "bob", "ack, I'll rename mine");
  store.postMessage(thread.id, "alice", "sounds good");

  const messages = store.messages(thread.id);
  assert.equal(messages.length, 3);
  assert.equal(messages[1].authorId, "bob");
  assert.equal(messages[1].message, "ack, I'll rename mine");
  assert.equal(messages[2].authorId, "alice");
});

test("AlignmentThreadStore: postSystemMessage requires an existing thread", () => {
  const { store } = freshStore();
  assert.equal(store.postSystemMessage("no-such-thread", "resolved"), undefined);
});

test("AlignmentThreadStore: postSystemMessage appends an author-less message, same as the auto-generated seed note", () => {
  const { store } = freshStore();
  const thread = store.findOrCreate(baseInput);
  store.postSystemMessage(thread.id, "Resolved: alice's design was approved");

  const messages = store.messages(thread.id);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].message, "Resolved: alice's design was approved");
  assert.equal(messages[1].authorId, undefined, "a system note has no author, same as the seed message");
});

test("AlignmentThreadStore: close is idempotent -- closing twice doesn't double-log", () => {
  const { store } = freshStore();
  const thread = store.findOrCreate(baseInput);
  store.close(thread.id, "alice");
  store.close(thread.id, "bob"); // second close, different closer -- must be a no-op
  const closed = store.get(thread.id);
  assert.equal(closed?.status, "closed");
  assert.equal(closed?.closedBy, "alice", "the first close wins; a second close must not overwrite it");
});

test("AlignmentThreadStore: close returns undefined for an unknown thread", () => {
  const { store } = freshStore();
  assert.equal(store.close("no-such-thread", "alice"), undefined);
});

test("AlignmentThreadStore: fromRow degrades a pre-2026-08-23 row gracefully -- symbolIds/lastActivityAt fall back, category/summary/initiatingDesignId stay undefined", () => {
  const { store, db } = freshStore();
  db.insert(threadsTable)
    .values({
      id: "legacy-1",
      projectId: "p1",
      symbolId: "src/legacy.ts::Old.thing",
      developerId: "alice",
      otherDeveloperId: "bob",
      designId: "d1",
      status: "open",
      systemDescription: "a thread from before the 2026-08-23 redesign",
      openedAt: 1000,
      closedAt: null,
      closedBy: null,
      // category/summary/initiatingDesignId/lastActivityAt omitted -- absent
      // on a real pre-migration row; symbolIds keeps its schema default.
    })
    .run();

  const legacy = store.get("legacy-1");
  assert.ok(legacy);
  assert.deepEqual(legacy?.symbolIds, ["src/legacy.ts::Old.thing"], "falls back to the legacy singular symbolId");
  assert.equal(legacy?.lastActivityAt, 1000, "falls back to openedAt");
  assert.equal(legacy?.category, undefined);
  assert.equal(legacy?.summary, undefined);
  assert.equal(legacy?.initiatingDesignId, undefined);
});

test("buildAlignmentSummary: templates a concise label per category, capping a long design summary", () => {
  assert.equal(buildAlignmentSummary("duplication", "Add retry backoff", 0), 'Duplicate work with "Add retry backoff"');
  assert.equal(buildAlignmentSummary("contradictory_assumptions", "Add retry backoff", 0), 'Contradicts "Add retry backoff"');
  assert.equal(buildAlignmentSummary("tension", "Add retry backoff", 0), 'Tension with "Add retry backoff"');
  assert.equal(buildAlignmentSummary("real_edit_collision", "Add retry backoff", 1), '1 overlapping symbol with "Add retry backoff"');
  assert.equal(buildAlignmentSummary("real_edit_collision", "Add retry backoff", 3), '3 overlapping symbols with "Add retry backoff"');
  assert.equal(buildAlignmentSummary("duplication", "(no summary)", 0), 'Duplicate work with "(no summary)"');

  const long = "x".repeat(120);
  const capped = buildAlignmentSummary("tension", long, 0);
  assert.ok(capped.length < long.length, "a long design summary must be capped, not embedded verbatim");
  assert.ok(capped.includes("…"));
});
