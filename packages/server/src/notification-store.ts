/**
 * The dashboard's notification feed: which design discussions have moved
 * since this developer last looked (2026-09).
 *
 * Design review reaches someone three ways -- a comment, a reply, a resolve --
 * and the bell is how a person in the dashboard finds out. (A design's owner
 * also hears about open comments from their coding sessions, through
 * `GET /v1/review-queue`; the bell is the dashboard's half.)
 *
 * **Nothing here is stored.** The feed is derived on every request from
 * `activity_events` joined through `design_comments`, because every event it
 * shows is already written there on the transition that caused it. The only
 * persisted state is one read cursor per developer
 * (`notificationReads`) -- so there is no notification table to keep
 * consistent with the log it mirrors, and a comment on a design with twelve
 * reviewers is still one insert rather than thirteen.
 *
 * **Your own actions never notify you.** Compared on the event's
 * `developerId`, so replying to your own thread stays silent. Every event
 * that reaches this feed is a person's since the 2026-09-27 rework -- the
 * coordinator no longer posts answers of its own -- so there is no longer an
 * agent/human split to filter on.
 *
 * `NOTIFYING_KINDS` is an allowlist rather than a denylist, which is what
 * keeps `design_chat_message` structurally out of this. A chat belongs to
 * one reviewer and must never surface anywhere else
 * (`design-chat-store.ts`); with a denylist that would be a rule someone has
 * to remember when the next event kind is added, and with an allowlist it is
 * simply absent.
 */

import { and, desc, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { activityEvents, designComments, designs, notificationReads } from "./db/schema.js";
import type { ActivityEventKind } from "./activity-log.js";

/** The only event kinds that ever reach a bell. See this file's header for
 * why `design_chat_message` is absent. */
export const NOTIFYING_KINDS: readonly ActivityEventKind[] = ["design_comment_posted", "design_comment_replied", "design_comment_resolved"];

/** How much of a comment or reply the bell shows before the reader has to
 * open the design. Long enough to recognise which question this is. */
const EXCERPT_CHARS = 180;

/** How many of the newest notifying events one feed read looks at.
 *
 * The badge is exact within this window. Past 200 unread notifications the
 * count is a floor, which the UI cannot show anyway: the badge caps at "9+".
 * The bound matters because this runs on a poll for every signed-in
 * dashboard user, and the alternative is reading every notifying event ever
 * written on every design they have taken part in, on every tick. */
const WINDOW_ROWS = 200;

const DEFAULT_LIMIT = 50;

export interface NotificationItem {
  /** The activity event's own id -- stable, so a client can key on it. */
  id: string;
  kind: ActivityEventKind;
  ts: number;
  /** Who did it. Never the caller: their own actions are filtered out. */
  actorId: string;
  projectId: string;
  designId: string;
  designSummary: string;
  commentId: string;
  /** The reply's text, or the comment's, trimmed to `EXCERPT_CHARS`. */
  excerpt: string;
  /** Whether this still counts toward the badge -- newer than the read
   * cursor. */
  unread: boolean;
}

export interface NotificationFeed {
  items: NotificationItem[];
  unreadCount: number;
  lastSeenAt: number;
}

/** One joined row behind a feed item. */
interface FeedRow {
  event: { id: string; projectId: string; developerId: string | null; kind: string; relatedId: string | null; ts: number; payload: string | null };
  comment: { id: string; designId: string; body: string };
  designSummary: string;
}

interface ReadRow {
  developerId: string;
  lastSeenAt: number;
  updatedAt: number;
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= EXCERPT_CHARS ? flat : flat.slice(0, EXCERPT_CHARS - 1) + "…";
}

/** `design_comment_replied` carries the reply text in its payload; the other
 * kinds carry no text of their own and fall back to the comment being acted
 * on. A payload that will not parse falls back the same way. */
function payloadMessage(raw: string | null): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    const message = typeof parsed === "object" && parsed !== null ? (parsed as { message?: unknown }).message : undefined;
    return typeof message === "string" ? message : undefined;
  } catch {
    return undefined;
  }
}

export class NotificationStore {
  constructor(private db: Db) {}

  /**
   * Every design this developer is entitled to hear about: the ones they
   * own, plus the ones they are in the discussion of.
   *
   * Participation is **derived, never stored** -- you are in a discussion
   * because you authored a comment on it or replied to one, both of which
   * are already recorded. Nothing has to be written when someone joins a
   * conversation, and nothing goes stale when a design is closed.
   *
   * Ownership is keyed on `designs.developerId` for the same reason
   * `openReviewsFor` is (`design-comment-store.ts`): a person's
   * dashboard-login identity can differ from the one their CLI authors
   * designs under, and the discussion has to reach whoever is building the
   * thing.
   */
  designIdsForDeveloper(developerId: string): string[] {
    const owned = this.db.select({ id: designs.id }).from(designs).where(eq(designs.developerId, developerId)).all() as { id: string }[];

    const commentedOn = this.db.select({ designId: designComments.designId }).from(designComments).where(eq(designComments.authorId, developerId)).all() as { designId: string }[];

    // Replies live only in the activity log -- there is no replies table --
    // so this is the one leg that has to go through `activity_events`. It is
    // also why `activity_events(developer_id, kind)` is indexed.
    const repliedTo = this.db
      .select({ designId: designComments.designId })
      .from(activityEvents)
      .innerJoin(designComments, eq(activityEvents.relatedId, designComments.id))
      .where(and(eq(activityEvents.developerId, developerId), eq(activityEvents.kind, "design_comment_replied")))
      .all() as { designId: string }[];

    const ids = new Set<string>();
    for (const row of owned) ids.add(row.id);
    for (const row of commentedOn) ids.add(row.designId);
    for (const row of repliedTo) ids.add(row.designId);
    return [...ids];
  }

  lastSeenAt(developerId: string): number {
    const row = this.db.select().from(notificationReads).where(eq(notificationReads.developerId, developerId)).get() as ReadRow | undefined;
    return row?.lastSeenAt ?? 0;
  }

  /** Marks everything currently visible as read. All-or-nothing on purpose
   * -- see `notificationReads`' own comment in the schema. */
  markSeen(developerId: string, ts: number = Date.now()): number {
    this.db
      .insert(notificationReads)
      .values({ developerId, lastSeenAt: ts, updatedAt: ts })
      .onConflictDoUpdate({ target: notificationReads.developerId, set: { lastSeenAt: ts, updatedAt: ts } })
      .run();
    return ts;
  }

  /**
   * The feed itself, newest first.
   *
   * `projectIds` is the caller's *current* access -- membership, plus the
   * projects they administer through an org, which `canCommentOnDesign`
   * already lets them join a discussion in. Required rather than optional,
   * the same call it is at `countsByDesign`: participation is derived from
   * history, so a design you commented on in a project you have since left
   * would otherwise keep notifying you forever, and the derivation alone
   * cannot see that you left. An empty array yields an empty feed, which is
   * the right answer for a developer who is in no projects.
   *
   * Bounded to the most recent `WINDOW_ROWS` notifying events, which is what
   * the panel shows and what the badge counts.
   */
  feedFor(developerId: string, projectIds: string[], options: { limit?: number; canReadComment?: (commentId: string) => boolean } = {}): NotificationFeed {
    const lastSeen = this.lastSeenAt(developerId);
    const limit = options.limit ?? DEFAULT_LIMIT;
    if (projectIds.length === 0) return { items: [], unreadCount: 0, lastSeenAt: lastSeen };

    const designIds = this.designIdsForDeveloper(developerId);
    if (designIds.length === 0) return { items: [], unreadCount: 0, lastSeenAt: lastSeen };

    const rows = this.db
      .select({ event: activityEvents, comment: designComments, designSummary: designs.summary })
      .from(activityEvents)
      .innerJoin(designComments, eq(activityEvents.relatedId, designComments.id))
      .innerJoin(designs, eq(designComments.designId, designs.id))
      .where(
        and(
          inArray(activityEvents.kind, [...NOTIFYING_KINDS]),
          inArray(designComments.designId, designIds),
          inArray(activityEvents.projectId, projectIds),
          // Your own actions never notify you. Applied in SQL rather than
          // after the fact, so the window is a window of real items. A
          // system-generated event has a NULL developerId, and `NULL <> 'me'`
          // is NULL in SQLite, so those drop out here too -- which is right:
          // there is nobody to attribute them to.
          ne(activityEvents.developerId, developerId),
        ),
      )
      .orderBy(desc(activityEvents.ts))
      .limit(Math.max(limit, WINDOW_ROWS))
      .all() as FeedRow[];

    const visible = options.canReadComment ? rows.filter((row) => options.canReadComment!(row.comment.id)) : rows;
    const all = this.toItems(visible, lastSeen);
    const unreadCount = all.filter((i) => i.unread).length;
    return { items: all.slice(0, limit), unreadCount, lastSeenAt: lastSeen };
  }

  private toItems(rows: FeedRow[], lastSeen: number): NotificationItem[] {
    const items: NotificationItem[] = [];
    for (const row of rows) {
      const actorId = row.event.developerId;
      if (!actorId) continue; // system-generated; nobody to attribute it to
      items.push({
        id: row.event.id,
        kind: row.event.kind as ActivityEventKind,
        ts: row.event.ts,
        actorId,
        projectId: row.event.projectId,
        designId: row.comment.designId,
        designSummary: row.designSummary,
        commentId: row.comment.id,
        excerpt: excerpt(payloadMessage(row.event.payload) ?? row.comment.body),
        unread: row.event.ts > lastSeen,
      });
    }
    return items;
  }
}
