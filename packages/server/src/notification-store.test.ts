/**
 * The notification feed's rules, each of which is easy to get backwards.
 *
 * The one that carries the feature is the agent/human split: every comment
 * automatically produces an agent answer, so a feed that counted agent
 * activity would show two or three items for every single comment posted.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createDb, type Db } from "./db/client.js";
import { designs as designsTable } from "./db/schema.js";
import { DesignCommentStore } from "./design-comment-store.js";
import { DesignChatStore } from "./design-chat-store.js";
import { NotificationStore } from "./notification-store.js";

const OWNER = "owner@example.com";
const REVIEWER = "reviewer@example.com";
const OTHER = "other@example.com";
const PROJECT = "p1";
const ALL_PROJECTS = [PROJECT];

function fresh(): { db: Db; comments: DesignCommentStore; notifications: NotificationStore } {
  const db = createDb({ memory: true });
  return { db, comments: new DesignCommentStore(db), notifications: new NotificationStore(db) };
}

function seedDesign(db: Db, id: string, developerId: string, projectId = PROJECT): void {
  const now = Date.now();
  db.insert(designsTable)
    .values({
      id,
      groupId: id,
      projectId,
      developerId,
      sessionId: "s1",
      status: "open",
      createdAt: now,
      summary: `design ${id}`,
      creates: "[]",
      touches: "[]",
      dependsOn: "[]",
      ttlMs: 1000,
      lastActivityAt: now,
    })
    .run();
}

/** A comment by `REVIEWER` on a design `OWNER` built -- the starting state
 * of nearly every case below. */
function seedDiscussion(db: Db, comments: DesignCommentStore) {
  seedDesign(db, "d1", OWNER);
  return comments.create({ projectId: PROJECT, designId: "d1", authorId: REVIEWER, body: "why a new table rather than reusing threads?" });
}

// --- rule 1: only a human's action notifies -------------------------------

test("NotificationStore: an agent's reply does not notify, a human reply on the same comment does", () => {
  const { db, comments, notifications } = fresh();
  const comment = seedDiscussion(db, comments);

  comments.addReply({ commentId: comment.id, authorKind: "agent", message: "the two have contradictory authorization rules" });
  assert.deepEqual(
    notifications.feedFor(REVIEWER, ALL_PROJECTS).items.map((i) => i.kind),
    [],
    "the coordinator answering is not news -- it happens on every comment",
  );

  comments.addReply({ commentId: comment.id, authorKind: "human", authorId: OWNER, message: "agreed, leaving it" });
  const feed = notifications.feedFor(REVIEWER, ALL_PROJECTS);
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].kind, "design_comment_replied");
  assert.equal(feed.items[0].actorId, OWNER);
  assert.equal(feed.items[0].excerpt, "agreed, leaving it");
});

/**
 * The case above is the coordinator's own answer pass, which writes no
 * author id at all (`app.ts`'s `runCommentAnswerPass`) -- so the feed would
 * drop it even with no `authorKind` check, simply for having nobody to
 * attribute it to.
 *
 * This is the case that actually needs the check. An agent replying through
 * `twing design comment reply` authenticates with its developer's token, and
 * `POST /v1/comments/:id/replies` stamps `authorId` from that token whatever
 * `authorKind` says -- so the event carries a real person's id and only
 * `authorKind` tells the two apart. Without this test, removing the filter
 * entirely breaks nothing that runs.
 */
test("NotificationStore: an agent reply posted under its developer's token still does not notify", () => {
  const { db, comments, notifications } = fresh();
  const comment = seedDiscussion(db, comments);

  comments.addReply({ commentId: comment.id, authorKind: "agent", authorId: OWNER, message: "answering on the owner's behalf, through the owner's token" });
  assert.deepEqual(notifications.feedFor(REVIEWER, ALL_PROJECTS).items, [], "authorKind is the only thing that can tell this from the owner typing");

  // And the same person's own words, on the same comment, do notify --
  // otherwise this would pass by filtering out the developer rather than
  // the agent.
  comments.addReply({ commentId: comment.id, authorKind: "human", authorId: OWNER, message: "and here I am, actually typing" });
  assert.deepEqual(
    notifications.feedFor(REVIEWER, ALL_PROJECTS).items.map((i) => i.excerpt),
    ["and here I am, actually typing"],
  );
});

// --- who hears about what -------------------------------------------------

test("NotificationStore: the design's owner is notified of a comment on it", () => {
  const { db, comments, notifications } = fresh();
  seedDiscussion(db, comments);

  const feed = notifications.feedFor(OWNER, ALL_PROJECTS);
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].kind, "design_comment_posted");
  assert.equal(feed.items[0].designId, "d1");
  assert.equal(feed.items[0].designSummary, "design d1");
  assert.equal(feed.unreadCount, 1);
});

test("NotificationStore: a reviewer who commented hears about a later reply and about the resolve", () => {
  const { db, comments, notifications } = fresh();
  const comment = seedDiscussion(db, comments);

  comments.addReply({ commentId: comment.id, authorKind: "human", authorId: OWNER, message: "because threads are party-scoped" });
  comments.resolve(comment.id, REVIEWER);

  // Resolving is the reviewer's own action, so it reaches the owner, not them.
  assert.deepEqual(
    notifications.feedFor(REVIEWER, ALL_PROJECTS).items.map((i) => i.kind),
    ["design_comment_replied"],
  );
  assert.deepEqual(
    notifications.feedFor(OWNER, ALL_PROJECTS).items.map((i) => i.kind),
    ["design_comment_resolved", "design_comment_posted"],
    "newest first",
  );
});

test("NotificationStore: replying to a discussion joins it, without being stored anywhere", () => {
  const { db, comments, notifications } = fresh();
  const comment = seedDiscussion(db, comments);
  // OTHER has neither built the design nor commented -- replying is the only
  // thing tying them to it.
  assert.deepEqual(notifications.designIdsForDeveloper(OTHER), []);

  comments.addReply({ commentId: comment.id, authorKind: "human", authorId: OTHER, message: "I hit this too" });
  assert.deepEqual(notifications.designIdsForDeveloper(OTHER), ["d1"]);

  comments.addReply({ commentId: comment.id, authorKind: "human", authorId: OWNER, message: "fair" });
  // Joining hands you the discussion's backlog, not just what happens next:
  // there is no "joined at" timestamp to filter against, because nothing is
  // written when someone joins -- that is the point of deriving it. Landing
  // in a thread with its opening question in front of you is the better
  // reading of the two anyway, and the first markSeen clears it.
  assert.deepEqual(
    notifications.feedFor(OTHER, ALL_PROJECTS).items.map((i) => i.actorId),
    [OWNER, REVIEWER],
    "newest first: the owner's reply, then the comment that opened the thread",
  );
});

test("NotificationStore: your own actions never notify you", () => {
  const { db, comments, notifications } = fresh();
  const comment = seedDiscussion(db, comments);
  comments.addReply({ commentId: comment.id, authorKind: "human", authorId: REVIEWER, message: "actually, never mind" });
  comments.escalate(comment.id, REVIEWER);

  assert.deepEqual(notifications.feedFor(REVIEWER, ALL_PROJECTS).items, [], "the reviewer did all three of these things");
});

test("NotificationStore: a design you have nothing to do with never reaches you", () => {
  const { db, comments, notifications } = fresh();
  seedDesign(db, "d2", OTHER);
  comments.create({ projectId: PROJECT, designId: "d2", authorId: OTHER, body: "a conversation between two other people" });

  assert.deepEqual(notifications.feedFor(REVIEWER, ALL_PROJECTS).items, []);
});

// --- privacy --------------------------------------------------------------

test("NotificationStore: a private chat message never surfaces, however busy the thread", () => {
  const { db, comments, notifications } = fresh();
  seedDesign(db, "d1", OWNER);
  const chats = new DesignChatStore(db);
  const chat = chats.findOrCreate({ projectId: PROJECT, designId: "d1", reviewerId: REVIEWER });
  chats.append(chat.id, { role: "reviewer", message: "is this even the right table?", ts: Date.now() });
  chats.append(chat.id, { role: "agent", message: "yes, because...", ts: Date.now() });

  // Even the design's own owner -- who is notified of everything else on it.
  assert.deepEqual(notifications.feedFor(OWNER, ALL_PROJECTS).items, [], "chats belong to one reviewer and leave no trace here");
  void comments;
});

// --- project membership ---------------------------------------------------

test("NotificationStore: leaving a project stops its designs notifying you", () => {
  const { db, comments, notifications } = fresh();
  seedDiscussion(db, comments);

  assert.equal(notifications.feedFor(OWNER, ALL_PROJECTS).items.length, 1);
  // Participation is derived from history, which cannot see that you left --
  // so the caller's *current* membership has to be what bounds the feed.
  assert.deepEqual(notifications.feedFor(OWNER, ["some-other-project"]).items, []);
  assert.deepEqual(notifications.feedFor(OWNER, []).items, []);
});

// --- the read cursor ------------------------------------------------------

test("NotificationStore: markSeen clears the badge but leaves the items readable", () => {
  const { db, comments, notifications } = fresh();
  seedDiscussion(db, comments);

  assert.equal(notifications.feedFor(OWNER, ALL_PROJECTS).unreadCount, 1);
  notifications.markSeen(OWNER, Date.now() + 1000);

  const after = notifications.feedFor(OWNER, ALL_PROJECTS);
  assert.equal(after.unreadCount, 0);
  assert.equal(after.items.length, 1, "seen is not gone");
  assert.equal(after.items[0].unread, false);
});

test("NotificationStore: an unacknowledged escalation outlives markSeen", () => {
  const { db, comments, notifications } = fresh();
  const comment = seedDiscussion(db, comments);
  comments.escalate(comment.id, REVIEWER);

  notifications.markSeen(OWNER, Date.now() + 1000);
  const feed = notifications.feedFor(OWNER, ALL_PROJECTS);

  // An escalation is state, not news: somebody is blocked waiting on the
  // owner, so a stray click on the bell must not bury it.
  const escalation = feed.items.find((i) => i.kind === "design_comment_escalated");
  assert.ok(escalation, "the escalation is in the feed");
  assert.equal(escalation.unread, true);
  assert.equal(feed.unreadCount, 1, "and it is the only thing still counting -- the comment itself was read");

  // Even a short panel must include the state that keeps its badge lit.
  comments.create({ projectId: PROJECT, designId: "d1", authorId: REVIEWER, body: "newer question" });
  assert.ok(notifications.feedFor(OWNER, ALL_PROJECTS, { limit: 1 }).items.some((i) => i.id === escalation.id));

  comments.acknowledge(comment.id, OWNER);
  assert.equal(notifications.feedFor(OWNER, ALL_PROJECTS).unreadCount, 0, "acknowledging is what ends the persistent escalation");
});

test("NotificationStore: an escalation on someone else's design is not held open for a bystander", () => {
  const { db, comments, notifications } = fresh();
  const comment = seedDiscussion(db, comments);
  comments.addReply({ commentId: comment.id, authorKind: "human", authorId: OTHER, message: "I hit this too" });
  comments.escalate(comment.id, REVIEWER);

  // OTHER is in the discussion, so they see it -- but it is waiting on the
  // design's owner, not on them, so the cursor ends it as it would any item.
  notifications.markSeen(OTHER, Date.now() + 1000);
  assert.equal(notifications.feedFor(OTHER, ALL_PROJECTS).unreadCount, 0);
  // The owner has read nothing, so all three -- the comment, the reply and
  // the escalation -- are still theirs to deal with.
  assert.equal(notifications.feedFor(OWNER, ALL_PROJECTS).unreadCount, 3);
});

test("NotificationStore: agent replies do not consume the panel limit or hide unread activity", () => {
  const { db, comments, notifications } = fresh();
  const comment = seedDiscussion(db, comments);
  for (let i = 0; i < 60; i++) {
    comments.addReply({ commentId: comment.id, authorKind: "agent", authorId: REVIEWER, message: `automatic answer ${i}` });
  }

  const feed = notifications.feedFor(OWNER, ALL_PROJECTS, { limit: 1 });
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].kind, "design_comment_posted");
  assert.equal(feed.unreadCount, 1);

  const second = comments.create({ projectId: PROJECT, designId: "d1", authorId: REVIEWER, body: "another question" });
  assert.ok(second);
  const limited = notifications.feedFor(OWNER, ALL_PROJECTS, { limit: 1 });
  assert.equal(limited.items.length, 1);
  assert.equal(limited.unreadCount, 2, "the badge includes items below the panel limit");
});

// --- bounds and ordering --------------------------------------------------

/**
 * The badge has to survive a long run of agent replies at the top of the log.
 *
 * This is the case the SQL `LIMIT` originally got wrong: it trimmed before
 * the agent/human filter ran, so a page full of the coordinator's own answers
 * -- which is the normal shape, since every comment triggers one -- left the
 * badge reading zero with real human activity right behind it.
 */
test("NotificationStore: human activity behind a wall of agent replies still counts", () => {
  const { db, comments, notifications } = fresh();
  const comment = seedDiscussion(db, comments);
  comments.addReply({ commentId: comment.id, authorKind: "human", authorId: OTHER, message: "the one thing worth seeing" });
  for (let i = 0; i < 60; i++) {
    comments.addReply({ commentId: comment.id, authorKind: "agent", authorId: OWNER, message: `agent answer ${i}` });
  }

  const feed = notifications.feedFor(REVIEWER, ALL_PROJECTS, { limit: 10 });
  assert.equal(feed.unreadCount, 1, "60 agent replies must not push the one human reply off the count");
  assert.deepEqual(
    feed.items.map((i) => i.excerpt),
    ["the one thing worth seeing"],
  );
});

test("NotificationStore: the page is capped at the requested limit", () => {
  const { db, comments, notifications } = fresh();
  seedDesign(db, "d1", OWNER);
  for (let i = 0; i < 25; i++) {
    comments.create({ projectId: PROJECT, designId: "d1", authorId: REVIEWER, body: `question ${i}` });
  }

  const feed = notifications.feedFor(OWNER, ALL_PROJECTS, { limit: 10 });
  assert.equal(feed.items.length, 10, "the panel shows a page");
  assert.equal(feed.unreadCount, 25, "the badge counts past it");
  // Newest first, throughout -- the client renders in array order.
  const timestamps = feed.items.map((i) => i.ts);
  assert.deepEqual([...timestamps].sort((a, b) => b - a), timestamps);
});

/**
 * An escalation is the one thing here somebody is actually blocked on, so it
 * has to stay reachable however much newer discussion has piled on top --
 * and still arrive in the right place in the order, rather than stapled to
 * the end of a list the client renders newest-first.
 */
test("NotificationStore: an old escalation stays reachable past the page, in date order", () => {
  const { db, comments, notifications } = fresh();
  const old = seedDiscussion(db, comments);
  comments.escalate(old.id, REVIEWER);
  const escalatedAt = notifications.feedFor(OWNER, ALL_PROJECTS).items.find((i) => i.kind === "design_comment_escalated")!.ts;

  // Bury it under newer comments, then read only a short page.
  for (let i = 0; i < 20; i++) {
    comments.create({ projectId: PROJECT, designId: "d1", authorId: OTHER, body: `later question ${i}` });
  }

  const feed = notifications.feedFor(OWNER, ALL_PROJECTS, { limit: 3 });
  const escalation = feed.items.find((i) => i.kind === "design_comment_escalated");
  assert.ok(escalation, "pushed past the page, but still in the feed");
  assert.equal(escalation.unread, true);

  const timestamps = feed.items.map((i) => i.ts);
  assert.deepEqual([...timestamps].sort((a, b) => b - a), timestamps, "still newest-first, not appended after the page");
  assert.ok(escalation.ts <= escalatedAt, "and it is the old one, in its own place in the order");
});

test("NotificationStore: acknowledging the escalation is what lets the page forget it", () => {
  const { db, comments, notifications } = fresh();
  const old = seedDiscussion(db, comments);
  comments.escalate(old.id, REVIEWER);
  for (let i = 0; i < 20; i++) {
    comments.create({ projectId: PROJECT, designId: "d1", authorId: OTHER, body: `later question ${i}` });
  }
  comments.acknowledge(old.id, OWNER);

  const feed = notifications.feedFor(OWNER, ALL_PROJECTS, { limit: 3 });
  assert.equal(feed.items.length, 3, "no longer pinned into the page");
  assert.equal(
    feed.items.some((i) => i.kind === "design_comment_escalated"),
    false,
  );
});
