import { test } from "node:test";
import assert from "node:assert/strict";
import { createDb, type Db } from "./db/client.js";
import { designs as designsTable } from "./db/schema.js";
import { DesignCommentStore } from "./design-comment-store.js";

function freshStore(): { store: DesignCommentStore; db: Db } {
  const db = createDb({ memory: true });
  return { store: new DesignCommentStore(db), db };
}

/** `openReviewsFor` joins comments to designs, so those tests need a real
 * design row to join against. Only the columns that query reads matter; the
 * rest are filled to satisfy NOT NULL. */
function seedDesign(db: Db, id: string, developerId: string, options: { summary?: string; status?: string; projectId?: string } = {}): void {
  const now = Date.now();
  db.insert(designsTable)
    .values({
      id,
      groupId: id,
      projectId: options.projectId ?? "p1",
      developerId,
      sessionId: "s1",
      status: options.status ?? "open",
      createdAt: now,
      summary: options.summary ?? "a design",
      creates: "[]",
      touches: "[]",
      dependsOn: "[]",
      ttlMs: 1000,
      lastActivityAt: now,
    })
    .run();
}

const baseComment = { projectId: "p1", designId: "d1", authorId: "reviewer@example.com", body: "why a new table rather than reusing threads?", designVersion: 3 };

test("DesignCommentStore: a new comment starts open, with no replies", () => {
  const { store } = freshStore();
  const comment = store.create(baseComment);
  assert.equal(comment.status, "open");
  assert.equal(comment.authorId, "reviewer@example.com");
  assert.equal(comment.designVersion, 3);
  assert.equal(comment.anchor, undefined, "a comment on the design as a whole has no anchor");
  assert.deepEqual(store.replies(comment.id), []);
});

test("DesignCommentStore: an anchor round-trips through the row, change id and context included", () => {
  const { store } = freshStore();
  const anchor = { field: "change" as const, changeId: "c2", quote: "cap exponential growth", prefix: "RetryPolicy ", suffix: " at 30s" };
  const created = store.create({ ...baseComment, anchor });
  assert.deepEqual(created.anchor, anchor);
  assert.deepEqual(store.get(created.id)?.anchor, anchor);
});

test("DesignCommentStore: an anchor without context stores none rather than empty strings", () => {
  const { store } = freshStore();
  const created = store.create({ ...baseComment, anchor: { field: "summary", quote: "retry budget" } });
  assert.deepEqual(store.get(created.id)?.anchor, { field: "summary", quote: "retry budget" });
});

test("DesignCommentStore: replies are read back oldest-first with their author", () => {
  const { store } = freshStore();
  const comment = store.create(baseComment);
  store.addReply({ commentId: comment.id, authorId: "dev@example.com", message: "the two have contradictory authorization rules" });
  store.addReply({ commentId: comment.id, authorId: "reviewer@example.com", message: "fair, leaving it" });

  const replies = store.replies(comment.id);
  assert.deepEqual(
    replies.map((r) => [r.authorId, r.message]),
    [
      ["dev@example.com", "the two have contradictory authorization rules"],
      ["reviewer@example.com", "fair, leaving it"],
    ],
  );
});

test("DesignCommentStore: resolve records who closed it, and a second resolve is not a second event", () => {
  const { store } = freshStore();
  const comment = store.create(baseComment);
  const resolved = store.resolve(comment.id, "reviewer@example.com");
  assert.equal(resolved?.status, "resolved");
  assert.equal(resolved?.resolvedBy, "reviewer@example.com");

  const again = store.resolve(comment.id, "admin@example.com");
  assert.equal(again?.resolvedBy, "reviewer@example.com", "the first person to close it stays the one on record");
});

test("DesignCommentStore: openReviewsFor groups open comments by design, only for designs this developer owns", () => {
  const { store, db } = freshStore();
  seedDesign(db, "d1", "owner@example.com", { summary: "retry budget" });
  seedDesign(db, "d2", "someone-else@example.com");

  const first = store.create({ ...baseComment, designId: "d1" });
  const second = store.create({ ...baseComment, designId: "d1", body: "and the timeout?" });
  store.create({ ...baseComment, designId: "d2", body: "not yours" });

  assert.deepEqual(store.openReviewsFor("owner@example.com"), [{ designId: "d1", projectId: "p1", designSummary: "retry budget", commentIds: [first.id, second.id] }]);
});

test("DesignCommentStore: a resolved comment leaves the review queue, and a design with none left drops out", () => {
  const { store, db } = freshStore();
  seedDesign(db, "d1", "owner@example.com");
  const first = store.create(baseComment);
  const second = store.create({ ...baseComment, body: "second" });

  store.resolve(first.id, "reviewer@example.com");
  assert.deepEqual(store.openReviewsFor("owner@example.com")[0].commentIds, [second.id]);

  store.resolve(second.id, "reviewer@example.com");
  assert.deepEqual(store.openReviewsFor("owner@example.com"), []);
});

test("DesignCommentStore: a reply does not take a comment out of the review queue -- only resolving does", () => {
  const { store, db } = freshStore();
  seedDesign(db, "d1", "owner@example.com");
  const comment = store.create(baseComment);
  store.addReply({ commentId: comment.id, authorId: "owner@example.com", message: "answered in the design" });

  // Whether a reply answered the question is the asker's call.
  assert.equal(store.openReviewsFor("owner@example.com").length, 1);
});

test("DesignCommentStore: a comment on a closed design still reaches its owner", () => {
  // A design closes at session end; review routinely lands after that.
  const { store, db } = freshStore();
  seedDesign(db, "d1", "owner@example.com", { status: "closed" });
  store.create(baseComment);
  assert.equal(store.openReviewsFor("owner@example.com").length, 1);
});

test("DesignCommentStore: the review queue spans projects", () => {
  const { store, db } = freshStore();
  seedDesign(db, "d1", "owner@example.com", { projectId: "p1" });
  seedDesign(db, "d2", "owner@example.com", { projectId: "p2" });
  store.create({ ...baseComment, designId: "d1", projectId: "p1" });
  store.create({ ...baseComment, designId: "d2", projectId: "p2" });

  assert.deepEqual(
    store
      .openReviewsFor("owner@example.com")
      .map((r) => r.projectId)
      .sort(),
    ["p1", "p2"],
  );
});

test("DesignCommentStore: countsByDesign reports totals and unresolved separately", () => {
  const { store } = freshStore();
  const a = store.create({ ...baseComment, designId: "d1" });
  store.create({ ...baseComment, designId: "d1" });
  store.create({ ...baseComment, designId: "d2" });
  store.resolve(a.id, "reviewer@example.com");

  assert.deepEqual(store.countsByDesign(["d1", "d2", "d3"], "p1"), {
    d1: { total: 2, unresolved: 1 },
    d2: { total: 1, unresolved: 1 },
  });
});

test("DesignCommentStore: countsByDesign never counts a design outside the given project", () => {
  const { store } = freshStore();
  store.create({ ...baseComment, designId: "d9", projectId: "other-project" });
  assert.deepEqual(store.countsByDesign(["d9"], "p1"), {});
});

test("DesignCommentStore: an unknown comment id is undefined rather than a throw", () => {
  const { store } = freshStore();
  assert.equal(store.get("nope"), undefined);
  assert.equal(store.resolve("nope", "someone"), undefined);
  assert.equal(store.addReply({ commentId: "nope", authorId: "someone", message: "hello?" }), undefined);
});
