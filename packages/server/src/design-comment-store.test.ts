import { test } from "node:test";
import assert from "node:assert/strict";
import { createDb, type Db } from "./db/client.js";
import { designs as designsTable } from "./db/schema.js";
import { DesignCommentStore } from "./design-comment-store.js";

function freshStore(): { store: DesignCommentStore; db: Db } {
  const db = createDb({ memory: true });
  return { store: new DesignCommentStore(db), db };
}

/** `pendingEscalationsFor` joins comments to designs, so the escalation tests
 * need a real design row to join against. Only the columns that query reads
 * matter; the rest are filled to satisfy NOT NULL. */
function seedDesign(db: Db, id: string, developerId: string, summary = "a design", status = "open"): void {
  const now = Date.now();
  db.insert(designsTable)
    .values({
      id,
      groupId: id,
      projectId: "p1",
      developerId,
      sessionId: "s1",
      status,
      createdAt: now,
      summary,
      creates: "[]",
      touches: "[]",
      dependsOn: "[]",
      ttlMs: 1000,
      lastActivityAt: now,
    })
    .run();
}

const baseComment = { projectId: "p1", designId: "d1", authorId: "reviewer@example.com", body: "why a new table rather than reusing threads?" };

test("DesignCommentStore: a new comment starts open, unanswered and unescalated", () => {
  const { store } = freshStore();
  const comment = store.create(baseComment);
  assert.equal(comment.status, "open");
  assert.equal(comment.agentAnsweredAt, undefined);
  assert.equal(comment.escalatedAt, undefined);
  assert.equal(comment.authorId, "reviewer@example.com");
  assert.deepEqual(store.replies(comment.id), [], "no replies until the agent answers");
});

test("DesignCommentStore: replies are read back oldest-first with their author kind preserved", () => {
  const { store } = freshStore();
  const comment = store.create(baseComment);
  store.addReply({ commentId: comment.id, authorKind: "agent", message: "the two have contradictory authorization rules" });
  store.addReply({ commentId: comment.id, authorKind: "human", authorId: "dev@example.com", message: "agreed, leaving it" });

  const replies = store.replies(comment.id);
  assert.equal(replies.length, 2);
  assert.equal(replies[0].authorKind, "agent");
  assert.equal(replies[0].authorId, undefined, "the coordinator's own answer has no developer behind it");
  assert.equal(replies[1].authorKind, "human");
  assert.equal(replies[1].authorId, "dev@example.com");
});

test("DesignCommentStore: markAnswered moves open -> answered", () => {
  const { store } = freshStore();
  const comment = store.create(baseComment);
  const answered = store.markAnswered(comment.id);
  assert.equal(answered?.status, "answered");
  assert.ok(answered?.agentAnsweredAt, "the answer time is recorded");
});

// The race this guards is real and routine: the answer pass is a model call
// that can take seconds, and a reviewer who already knows they need the human
// clicks Escalate without waiting for it.
test("DesignCommentStore: markAnswered never drags an escalated comment back to answered", () => {
  const { store } = freshStore();
  const comment = store.create(baseComment);
  store.escalate(comment.id, "reviewer@example.com");

  const after = store.markAnswered(comment.id);
  assert.equal(after?.status, "escalated", "a reviewer's decision outranks a slow model call landing afterwards");
});

test("DesignCommentStore: escalate works straight from open, without waiting for an answer", () => {
  const { store } = freshStore();
  const comment = store.create(baseComment);
  const escalated = store.escalate(comment.id, "reviewer@example.com", "needs the author's intent");
  assert.equal(escalated?.status, "escalated");
  assert.equal(escalated?.escalatedBy, "reviewer@example.com");
});

test("DesignCommentStore: a resolved comment cannot be escalated", () => {
  const { store } = freshStore();
  const comment = store.create(baseComment);
  store.resolve(comment.id, "reviewer@example.com");
  assert.equal(store.escalate(comment.id, "reviewer@example.com"), undefined, "reopening a settled question is a new comment, not a state change");
});

// Acknowledging is what an agent does merely by *reading* its comments, so if
// it also resolved, an agent could silently close a reviewer's open question
// just by looking at it.
test("DesignCommentStore: acknowledge clears the banner without resolving the question", () => {
  const { store } = freshStore();
  const comment = store.create(baseComment);
  store.escalate(comment.id, "reviewer@example.com");

  const acked = store.acknowledge(comment.id, "dev@example.com");
  assert.ok(acked?.acknowledgedAt, "acknowledged");
  assert.equal(acked?.status, "escalated", "still escalated -- only a reviewer settles it");
});

test("DesignCommentStore: acknowledge is idempotent -- a second read is not a second event", () => {
  const { store } = freshStore();
  const comment = store.create(baseComment);
  store.escalate(comment.id, "reviewer@example.com");

  const first = store.acknowledge(comment.id, "dev@example.com");
  const second = store.acknowledge(comment.id, "dev@example.com");
  assert.equal(first?.acknowledgedAt, second?.acknowledgedAt);
});

test("DesignCommentStore: pendingEscalationsFor returns only unacknowledged escalations on designs this developer owns", () => {
  const { store, db } = freshStore();
  seedDesign(db, "d1", "owner@example.com", "the design under review");
  seedDesign(db, "d2", "someone-else@example.com");

  const mine = store.create({ ...baseComment, designId: "d1" });
  const theirs = store.create({ ...baseComment, designId: "d2" });
  const notEscalated = store.create({ ...baseComment, designId: "d1", body: "just a note" });
  store.escalate(mine.id, "reviewer@example.com");
  store.escalate(theirs.id, "reviewer@example.com");

  const pending = store.pendingEscalationsFor("owner@example.com");
  assert.equal(pending.length, 1, "someone else's design is not this developer's problem");
  assert.equal(pending[0].comment.id, mine.id);
  assert.equal(pending[0].designSummary, "the design under review", "the banner can name the work without a second lookup");
  assert.ok(!pending.some((p) => p.comment.id === notEscalated.id));

  store.acknowledge(mine.id, "owner@example.com");
  assert.deepEqual(store.pendingEscalationsFor("owner@example.com"), [], "acknowledging is what stops the banner");
});

// A commit -- and so a review of it -- routinely lands after handleSessionEnd
// has already closed the design. Filtering to open designs here would drop
// exactly the escalations that arrive late, which is most of them.
test("DesignCommentStore: an escalation on a closed design still reaches its owner", () => {
  const { store, db } = freshStore();
  seedDesign(db, "d1", "owner@example.com", "closed but still under review", "closed");
  const comment = store.create(baseComment);
  store.escalate(comment.id, "reviewer@example.com");

  const pending = store.pendingEscalationsFor("owner@example.com");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].designStatus, "closed");
});

test("DesignCommentStore: countsByDesign reports totals and unresolved separately", () => {
  const { store } = freshStore();
  const a = store.create(baseComment);
  store.create({ ...baseComment, body: "second" });
  store.create({ ...baseComment, designId: "d2", body: "other design" });
  store.resolve(a.id, "reviewer@example.com");

  const counts = store.countsByDesign(["d1", "d2", "d3"], "p1");
  assert.deepEqual(counts.d1, { total: 2, unresolved: 1 });
  assert.deepEqual(counts.d2, { total: 1, unresolved: 1 });
  assert.equal(counts.d3, undefined, "a design with no comments gets no entry, not a zero");
});

// Found in review: the caller supplies the design ids, so the authorized
// project has to constrain the rows or a member of one project can learn how
// much discussion another project's designs carry.
test("DesignCommentStore: countsByDesign never counts a design outside the given project", () => {
  const { store } = freshStore();
  store.create({ ...baseComment, projectId: "other-project", designId: "someone-elses-design" });

  assert.deepEqual(store.countsByDesign(["someone-elses-design"], "p1"), {}, "asking from p1 must see nothing of other-project's");
  assert.deepEqual(store.countsByDesign(["someone-elses-design"], "other-project"), { "someone-elses-design": { total: 1, unresolved: 1 } });
});

test("DesignCommentStore: an unknown comment id is undefined rather than a throw", () => {
  const { store } = freshStore();
  assert.equal(store.get("nope"), undefined);
  assert.equal(store.addReply({ commentId: "nope", authorKind: "agent", message: "x" }), undefined);
  assert.equal(store.markAnswered("nope"), undefined);
  assert.equal(store.escalate("nope", "reviewer@example.com"), undefined);
});

// Found in review: a follow-up left the comment reading `answered` for the
// whole time the agent was working on it, so the dashboard showed "answered
// by the agent" and dropped to its slow poll while a model call was in
// flight. `open` already means "there is a human question the agent has not
// answered yet", which is exactly true again after a follow-up.
test("DesignCommentStore: markAwaitingAnswer returns an answered comment to open", () => {
  const { store } = freshStore();
  const comment = store.create(baseComment);
  store.markAnswered(comment.id);

  const awaiting = store.markAwaitingAnswer(comment.id);
  assert.equal(awaiting?.status, "open");
  // And the round trip still works -- the next pass closes it out normally.
  assert.equal(store.markAnswered(comment.id)?.status, "answered");
});

test("DesignCommentStore: markAwaitingAnswer never drags an escalated or resolved comment back", () => {
  const { store } = freshStore();
  const escalated = store.create(baseComment);
  store.escalate(escalated.id, "reviewer@example.com");
  assert.equal(store.markAwaitingAnswer(escalated.id)?.status, "escalated", "a person owns this one");

  const resolved = store.create({ ...baseComment, body: "second" });
  store.resolve(resolved.id, "reviewer@example.com");
  assert.equal(store.markAwaitingAnswer(resolved.id)?.status, "resolved");
});

test("DesignCommentStore: markAwaitingAnswer on an already-open comment is a no-op", () => {
  const { store } = freshStore();
  const comment = store.create(baseComment);
  assert.equal(store.markAwaitingAnswer(comment.id)?.status, "open");
  assert.equal(store.markAwaitingAnswer("nope"), undefined);
});
