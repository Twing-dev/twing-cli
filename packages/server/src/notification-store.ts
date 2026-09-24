/**
 * The dashboard's notification feed: which design discussions are waiting on
 * this developer (2026-09).
 *
 * Design review can reach someone three ways -- a comment, an escalation, a
 * reply -- and until this existed there was exactly one way to find out: a
 * banner at the start of your next coding session, and only for escalations
 * on designs you own. A reviewer who asked a question never learned it had
 * been answered.
 *
 * **Nothing here is stored.** The feed is derived on every request from
 * `activity_events` joined through `design_comments`, because every event it
 * shows is already written there on the transition that caused it. The only
 * persisted state is one read cursor per developer
 * (`notificationReads`) -- so there is no notification table to keep
 * consistent with the log it mirrors, and a comment on a design with twelve
 * reviewers is still one insert rather than thirteen.
 *
 * Two rules do the real work, and both are easy to get backwards:
 *
 * 1. **Only a human's action notifies.** Every comment automatically
 *    triggers an agent answer, and often a second `[needs a human]` reply
 *    after it, so counting agent activity would show three items on the bell
 *    where one thing actually happened -- on every single comment. The
 *    filter is `payload.authorKind === "human"` for replies;
 *    `authorKind` exists precisely because a developer and their agent
 *    authenticate with the same token and the identity on the row cannot
 *    tell them apart (see `activity-log.ts`).
 * 2. **Your own actions never notify you.** Compared on the event's
 *    `developerId`, so replying to your own thread stays silent.
 *
 * `NOTIFYING_KINDS` is an allowlist rather than a denylist, which is what
 * keeps `design_chat_message` structurally out of this. A chat belongs to
 * one reviewer and must never surface anywhere else
 * (`design-chat-store.ts`); with a denylist that would be a rule someone has
 * to remember when the next event kind is added, and with an allowlist it is
 * simply absent.
 */

import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { activityEvents, designComments, designs, notificationReads } from "./db/schema.js";
import type { ActivityEventKind } from "./activity-log.js";

/**
 * The only event kinds that ever reach a bell.
 *
 * `design_comment_posted` needs no `authorKind` check: the CLI has no
 * comment-creation verb at all (only `comments` to read and `comment reply`
 * to answer), so a comment is always a person typing into the dashboard.
 * Replies are the mixed case, and the one filtered below.
 *
 * Deliberately absent: `design_comment_acknowledged`, which is bookkeeping
 * and is the design owner's own action, and `design_chat_message` -- see
 * this file's header.
 */
export const NOTIFYING_KINDS: readonly ActivityEventKind[] = ["design_comment_posted", "design_comment_replied", "design_comment_escalated", "design_comment_resolved"];

/** How much of a comment or reply the bell shows before the reader has to
 * open the design. Long enough to recognise which question this is. */
const EXCERPT_CHARS = 180;

/** How many of the newest events one feed read looks at.
 *
 * The badge is exact within this window (plus every waiting escalation, which
 * is fetched separately and has no time bound). Past it the count is a floor
 * -- which the UI cannot show anyway, since the badge caps at "9+". The bound
 * matters because this runs on a poll for every signed-in dashboard user, and
 * the alternative is reading every notifying event ever written on every
 * design they have taken part in, on every tick. */
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
   * cursor, or an escalation still waiting on the caller. */
  unread: boolean;
}

export interface NotificationFeed {
  items: NotificationItem[];
  unreadCount: number;
  lastSeenAt: number;
}

/** One joined row behind a feed item, shared by both of `feedFor`'s
 * queries. */
interface FeedRow {
  event: { id: string; projectId: string; developerId: string | null; kind: string; relatedId: string | null; ts: number; payload: string | null };
  comment: { id: string; designId: string; body: string; status: string; acknowledgedAt: number | null };
  designSummary: string;
  designOwner: string;
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

/** `design_comment_replied` carries the reply text and its author kind in
 * the payload; the other three carry no text of their own and fall back to
 * the comment being acted on. A payload that will not parse is treated as an
 * agent reply -- the conservative direction, since the failure mode of
 * guessing "human" is a bell that cries wolf on every answer. */
function parsePayload(raw: string | null): { authorKind?: string; message?: string } {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as { authorKind?: string; message?: string }) : {};
  } catch {
    return {};
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
   * `pendingEscalationsFor` is (`design-comment-store.ts`): a person's
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
   * `projectIds` is the caller's *current* membership and is required rather
   * than optional, the same call it is at `countsByDesign`. Participation is
   * derived from history, so a design you commented on in a project you have
   * since left would otherwise keep notifying you forever -- the derivation
   * alone cannot see that you left. Passing an empty array yields an empty
   * feed, which is the correct answer for a developer who is in no projects.
   */
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
   * Two queries rather than one, for two different bounds:
   *
   * - **A window of the most recent events** (`WINDOW_ROWS`), which is what
   *   the panel shows and what the badge counts. Bounded because this runs
   *   on a poll for every signed-in dashboard user; unbounded, it reads
   *   every notifying event ever written on every design they have ever
   *   taken part in, on each tick.
   * - **Every escalation still waiting on this developer**, with no time
   *   bound at all. Those are *state* rather than news and have to survive
   *   both the read cursor and the window, and there is never a large number
   *   of them -- the query is `status = 'escalated'` against an indexed
   *   column, not a scan.
   *
   * So the count is exact within the window, plus every waiting escalation
   * however old. That is a deliberate limit and not a hidden one: the badge
   * renders as "9+" past nine, so an exact total beyond the window buys
   * nothing anyone can see.
   */
  feedFor(developerId: string, projectIds: string[], options: { limit?: number } = {}): NotificationFeed {
    const lastSeen = this.lastSeenAt(developerId);
    const limit = options.limit ?? DEFAULT_LIMIT;
    if (projectIds.length === 0) return { items: [], unreadCount: 0, lastSeenAt: lastSeen };

    const designIds = this.designIdsForDeveloper(developerId);
    if (designIds.length === 0) return { items: [], unreadCount: 0, lastSeenAt: lastSeen };

    const scope = and(
      inArray(designComments.designId, designIds),
      inArray(activityEvents.projectId, projectIds),
      // Your own actions never notify you. Applied in SQL rather than after
      // the fact, so the window is a window of real items. A
      // system-generated event has a NULL developerId, and `NULL <> 'me'` is
      // NULL in SQLite, so those drop out here too -- which is right: there
      // is nobody to attribute them to.
      ne(activityEvents.developerId, developerId),
    );

    const windowRows = this.selectFeedRows(and(inArray(activityEvents.kind, [...NOTIFYING_KINDS]), scope), Math.max(limit, WINDOW_ROWS));

    // Escalations waiting on this developer, however old. Every condition of
    // "waiting on me" is in the query -- escalated, unacknowledged, and on a
    // design they own -- so every row it returns is one, and the pin below
    // needs no second opinion about it.
    const escalationRows = this.selectFeedRows(
      and(
        eq(activityEvents.kind, "design_comment_escalated"),
        eq(designComments.status, "escalated"),
        isNull(designComments.acknowledgedAt),
        eq(designs.developerId, developerId),
        scope,
      ),
    );
    const waitingOnMe = new Set(escalationRows.map((row) => row.event.id));

    const byId = new Map<string, NotificationItem>();
    for (const item of this.toItems([...windowRows, ...escalationRows], developerId, lastSeen)) byId.set(item.id, item);
    const all = [...byId.values()].sort((a, b) => b.ts - a.ts);

    const unreadCount = all.filter((i) => i.unread).length;
    const visible = new Set(all.slice(0, limit));
    // An escalation still waiting on you stays reachable even when newer
    // discussion has pushed it past the page -- it is the one thing here
    // that someone is actually blocked on. Keyed on `waitingOnMe`, not on
    // `unread`: an escalation that is merely newer than the read cursor is
    // ordinary news and takes its chances with everything else, and pinning
    // those too would hold a page open for items nobody is blocked on.
    // Re-sorted rather than appended, so what the client renders is still
    // newest-first throughout.
    for (const item of all) {
      if (waitingOnMe.has(item.id)) visible.add(item);
    }
    const items = [...visible].sort((a, b) => b.ts - a.ts);

    return { items, unreadCount, lastSeenAt: lastSeen };
  }

  private selectFeedRows(where: ReturnType<typeof and>, limit?: number): FeedRow[] {
    const query = this.db
      .select({ event: activityEvents, comment: designComments, designSummary: designs.summary, designOwner: designs.developerId })
      .from(activityEvents)
      .innerJoin(designComments, eq(activityEvents.relatedId, designComments.id))
      .innerJoin(designs, eq(designComments.designId, designs.id))
      .where(where)
      .orderBy(desc(activityEvents.ts));
    return (limit === undefined ? query.all() : query.limit(limit).all()) as FeedRow[];
  }

  private toItems(rows: FeedRow[], developerId: string, lastSeen: number): NotificationItem[] {
    const items: NotificationItem[] = [];
    for (const row of rows) {
      const payload = parsePayload(row.event.payload);
      // Rule 1: an agent's reply is not news. Every other kind here is
      // human by construction (see NOTIFYING_KINDS).
      if (row.event.kind === "design_comment_replied" && payload.authorKind !== "human") continue;
      const actorId = row.event.developerId;
      if (!actorId) continue; // system-generated; nobody to attribute it to

      // An escalation is *state*, not news: somebody is blocked waiting for
      // the design's owner. It keeps counting past the read cursor until it
      // is acknowledged or resolved, so a stray click on the bell cannot
      // bury the one thing here that is actually waiting on you.
      const escalationWaitingOnMe = row.event.kind === "design_comment_escalated" && row.designOwner === developerId && row.comment.status === "escalated" && row.comment.acknowledgedAt === null;

      items.push({
        id: row.event.id,
        kind: row.event.kind as ActivityEventKind,
        ts: row.event.ts,
        actorId,
        projectId: row.event.projectId,
        designId: row.comment.designId,
        designSummary: row.designSummary,
        commentId: row.comment.id,
        excerpt: excerpt(payload.message ?? row.comment.body),
        unread: row.event.ts > lastSeen || escalationWaitingOnMe,
      });
    }
    return items;
  }
}
