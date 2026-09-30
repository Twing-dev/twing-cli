/**
 * The notification feed's rules, each of which is easy to get backwards:
 * whose actions reach whom, what bounds the feed, and what the read cursor
 * does and does not clear.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createDb, type Db } from "./db/client.js";
import { activityEvents, designs as designsTable } from "./db/schema.js";
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

function comment(designId: string, authorId: string, body: string) {
  return { projectId: PROJECT, designId, authorId, body, designVersion: 0 };
}

/** A comment by `REVIEWER` on a design `OWNER` built -- the starting state
 * of nearly every case below. */
function seedDiscussion(db: Db, comments: DesignCommentStore) {
  seedDesign(db, "d1", OWNER);
  return comments.create(comment("d1", REVIEWER, "why a new table rather than reusing threads?"));
}

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
  const c = seedDiscussion(db, comments);

  comments.addReply({ commentId: c.id, authorId: OWNER, message: "because threads are party-scoped" });
  comments.resolve(c.id, REVIEWER);

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

test("NotificationStore: a reply's excerpt is the reply, not the comment it answers", () => {
  const { db, comments, notifications } = fresh();
  const c = seedDiscussion(db, comments);
  comments.addReply({ commentId: c.id, authorId: OWNER, message: "because threads are party-scoped" });

  assert.equal(notifications.feedFor(REVIEWER, ALL_PROJECTS).items[0].excerpt, "because threads are party-scoped");
});

test("NotificationStore: replying to a discussion joins it, without being stored anywhere", () => {
  const { db, comments, notifications } = fresh();
  const c = seedDiscussion(db, comments);
  // OTHER has neither built the design nor commented -- replying is the only
  // thing tying them to it.
  assert.deepEqual(notifications.designIdsForDeveloper(OTHER), []);

  comments.addReply({ commentId: c.id, authorId: OTHER, message: "I hit this too" });
  assert.deepEqual(notifications.designIdsForDeveloper(OTHER), ["d1"]);

  comments.addReply({ commentId: c.id, authorId: OWNER, message: "fair" });
  // Joining hands you the discussion's backlog, not just what happens next:
  // there is no "joined at" timestamp to filter against, because nothing is
  // written when someone joins -- that is the point of deriving it.
  assert.deepEqual(
    notifications.feedFor(OTHER, ALL_PROJECTS).items.map((i) => i.actorId),
    [OWNER, REVIEWER],
    "newest first: the owner's reply, then the comment that opened the thread",
  );
});

test("NotificationStore: your own actions never notify you", () => {
  const { db, comments, notifications } = fresh();
  const c = seedDiscussion(db, comments);
  comments.addReply({ commentId: c.id, authorId: REVIEWER, message: "actually, never mind" });
  comments.resolve(c.id, REVIEWER);

  assert.deepEqual(notifications.feedFor(REVIEWER, ALL_PROJECTS).items, [], "the reviewer did all three of these things");
});

test("NotificationStore: a design you have nothing to do with never reaches you", () => {
  const { db, comments, notifications } = fresh();
  seedDesign(db, "d2", OTHER);
  comments.create(comment("d2", OTHER, "a conversation between two other people"));

  assert.deepEqual(notifications.feedFor(REVIEWER, ALL_PROJECTS).items, []);
});

// --- privacy --------------------------------------------------------------

test("NotificationStore: a private chat message never surfaces, however busy the thread", () => {
  const { db, notifications } = fresh();
  seedDesign(db, "d1", OWNER);
  const chats = new DesignChatStore(db);
  const chat = chats.findOrCreate({ projectId: PROJECT, designId: "d1", reviewerId: REVIEWER });
  chats.append(chat.id, { role: "reviewer", message: "is this even the right table?", ts: Date.now() });
  chats.append(chat.id, { role: "agent", message: "yes, because...", ts: Date.now() });

  // Even the design's own owner -- who is notified of everything else on it.
  assert.deepEqual(notifications.feedFor(OWNER, ALL_PROJECTS).items, [], "chats belong to one reviewer and leave no trace here");
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

// --- the read cursor and the window ----------------------------------------

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

test("NotificationStore: the page is capped at the requested limit", () => {
  const { db, comments, notifications } = fresh();
  seedDesign(db, "d1", OWNER);
  for (let i = 0; i < 25; i++) comments.create(comment("d1", REVIEWER, `question ${i}`));

  const feed = notifications.feedFor(OWNER, ALL_PROJECTS, { limit: 10 });
  assert.equal(feed.items.length, 10, "the panel shows a page");
  assert.equal(feed.unreadCount, 25, "the badge counts past it");
  // Newest first, throughout -- the client renders in array order.
  const timestamps = feed.items.map((i) => i.ts);
  assert.deepEqual([...timestamps].sort((a, b) => b - a), timestamps);
});

test("NotificationStore: a malformed payload falls back to the comment's text, not an error", () => {
  const { db, comments, notifications } = fresh();
  const c = seedDiscussion(db, comments);

  db.insert(activityEvents)
    .values({
      id: "evt-garbage",
      projectId: PROJECT,
      developerId: OTHER,
      kind: "design_comment_replied",
      relatedId: c.id,
      ts: Date.now() + 1000,
      payload: "{not json at all",
    })
    .run();

  const feed = notifications.feedFor(REVIEWER, ALL_PROJECTS);
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].id, "evt-garbage");
  assert.equal(feed.items[0].excerpt, "why a new table rather than reusing threads?");
});
