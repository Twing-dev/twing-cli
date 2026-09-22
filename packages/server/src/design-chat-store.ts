/**
 * A reviewer's private conversation with a registered design (design review
 * phase 2, 2026-09).
 *
 * The third thing in this package built on "current-state table + messages as
 * `activity_events`", after alignment threads and design comments. The shape
 * is familiar; what differs is who may read it, and that difference is the
 * entire reason it is a separate store.
 *
 * **A comment is a question asked of the project. A chat is a reviewer
 * thinking.** Comments are public within the project, answered in the open,
 * and escalatable to the developer -- that is what makes them review
 * feedback. A chat is one person working out whether they understand a
 * design, grounded in the session that produced it, and most of what gets
 * asked there is half-formed by design. Publishing that would make people
 * stop asking; hiding comments would make review invisible. So they are two
 * surfaces, and this one is private to its owner.
 *
 * "Private" here means: only the reviewer who owns a thread can read its
 * messages, there is no route that returns another person's, and the project
 * activity feed cannot reach them either (`PRIVATE_EVENT_KINDS`,
 * activity-log.ts). A project admin can learn that a thread exists -- it is
 * their project, and `countForDesign` is how -- but not what is in it. There
 * is deliberately no admin override, for the same reason `isThreadParty` has
 * none: reading someone's working-out is not oversight.
 */

import * as crypto from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { designChats as chatsTable } from "./db/schema.js";
import { DrizzleActivityLog } from "./activity-log.js";

export interface DesignChat {
  id: string;
  projectId: string;
  designId: string;
  reviewerId: string;
  createdAt: number;
  lastActivityAt: number;
}

/** One turn. `role` rather than an author id: a chat has exactly two
 * participants, the reviewer who owns it and the coordinator answering, so a
 * developer id would be the same value on every reviewer row and absent on
 * every agent row. */
export interface DesignChatMessage {
  role: "reviewer" | "agent";
  message: string;
  ts: number;
  /** On an agent turn: the one line saying what the answer was grounded in
   * (`describeProvenance`, design-context.ts). Counts and ids only -- never
   * transcript text, which does not leave the server. */
  provenance?: string;
}

interface ChatRow {
  id: string;
  projectId: string;
  designId: string;
  reviewerId: string;
  createdAt: number;
  lastActivityAt: number;
}

export class DesignChatStore {
  private db: Db;
  private activityLog: DrizzleActivityLog;

  constructor(db: Db, options: { activityLog?: DrizzleActivityLog } = {}) {
    this.db = db;
    // The concrete log, not the write-only `ActivityLogWriter` interface:
    // `messages()` needs `eventsForRelatedId`, which that narrower type
    // does not carry. Same reason `AlignmentThreadStore` does it.
    this.activityLog = options.activityLog ?? new DrizzleActivityLog(db);
  }

  /**
   * This reviewer's thread on this design, created on first use.
   *
   * Keyed on the pair, so a reviewer's second question continues the
   * conversation they already started rather than forking a parallel one --
   * which is what makes follow-ups work at all.
   */
  findOrCreate(input: { projectId: string; designId: string; reviewerId: string }): DesignChat {
    const existing = this.find(input.designId, input.reviewerId);
    if (existing) return existing;

    const now = Date.now();
    const row: ChatRow = {
      id: crypto.randomUUID(),
      projectId: input.projectId,
      designId: input.designId,
      reviewerId: input.reviewerId,
      createdAt: now,
      lastActivityAt: now,
    };
    this.db.insert(chatsTable).values(row).run();
    return row;
  }

  find(designId: string, reviewerId: string): DesignChat | undefined {
    const row = this.db
      .select()
      .from(chatsTable)
      .where(and(eq(chatsTable.designId, designId), eq(chatsTable.reviewerId, reviewerId)))
      .get() as ChatRow | undefined;
    return row;
  }

  get(id: string): DesignChat | undefined {
    return this.db.select().from(chatsTable).where(eq(chatsTable.id, id)).get() as ChatRow | undefined;
  }

  /**
   * Every turn in one thread, oldest first.
   *
   * **Takes no reviewer id and performs no authorization.** The caller has
   * to have established ownership before getting here -- the routes do it by
   * resolving the thread through `find(designId, identity.developerId)`, so
   * there is no id to pass. Stated because a future caller reaching for this
   * with a thread id from somewhere else would be the way this leaks.
   */
  messages(chatId: string): DesignChatMessage[] {
    return this.activityLog
      .eventsForRelatedId(chatId)
      .filter((event) => event.kind === "design_chat_message")
      .map((event) => {
        const payload = (event.payload ?? {}) as { role?: unknown; message?: unknown; provenance?: unknown };
        return {
          // Anything unrecognised reads as the agent, not the reviewer: the
          // failure that matters is a model's words being taken for a
          // person's.
          role: payload.role === "reviewer" ? "reviewer" : ("agent" as const),
          message: typeof payload.message === "string" ? payload.message : "",
          ts: event.ts,
          provenance: typeof payload.provenance === "string" ? payload.provenance : undefined,
        };
      });
  }

  append(chatId: string, message: DesignChatMessage): DesignChatMessage | undefined {
    const chat = this.get(chatId);
    if (!chat) return undefined;
    const ts = Date.now();
    this.activityLog.append({
      projectId: chat.projectId,
      // The reviewer on their own turns, absent on the agent's -- matching
      // how comment replies record authorship.
      developerId: message.role === "reviewer" ? chat.reviewerId : undefined,
      kind: "design_chat_message",
      relatedId: chat.id,
      ts,
      payload: { designId: chat.designId, role: message.role, message: message.message, provenance: message.provenance },
    });
    this.db.update(chatsTable).set({ lastActivityAt: ts }).where(eq(chatsTable.id, chat.id)).run();
    return { ...message, ts };
  }

  /**
   * How many reviewers have a thread open on this design.
   *
   * The most an admin gets: that people are working through this design
   * privately, and roughly how many. Deliberately a count and not a list of
   * names -- "who is unsure about my design" is a chilling thing to publish,
   * and nobody needs it to run a project.
   */
  countForDesign(designId: string): number {
    return (this.db.select().from(chatsTable).where(eq(chatsTable.designId, designId)).all() as ChatRow[]).length;
  }

  /** This reviewer's threads across a project, newest activity first -- for
   * a "what was I looking at?" list. Scoped to one reviewer by construction;
   * there is no all-reviewers variant. */
  listForReviewer(projectId: string, reviewerId: string): DesignChat[] {
    return this.db
      .select()
      .from(chatsTable)
      .where(and(eq(chatsTable.projectId, projectId), eq(chatsTable.reviewerId, reviewerId)))
      .orderBy(asc(chatsTable.lastActivityAt))
      .all() as ChatRow[];
  }
}
