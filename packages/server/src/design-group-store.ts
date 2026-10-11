/**
 * The one piece of group-level state that's actually persisted (2026-10-10):
 * a human-written overview for a `groupId`, saved once someone edits the
 * combined view `group-overview-resynthesis.ts` otherwise only computes and
 * caches in memory. See `db/schema.ts`'s `designGroupOverviews` doc comment
 * for why a row's mere existence is the "a human settled on this text"
 * signal -- there's no automatic writer on this table to distinguish a
 * human row from, unlike `designs.overviewRevisionSource`.
 */

import { eq } from "drizzle-orm";
import { designGroupOverviews } from "./db/schema.js";
import type { Db } from "./db/client.js";

export interface DesignGroupOverview {
  groupId: string;
  overview: string;
  revisedBy: string;
  revisedAt: number;
}

export class DesignGroupStore {
  constructor(private readonly db: Db) {}

  /** The human-authored override for this group, if anyone has ever saved
   * one. `undefined` is the ordinary case -- most groups never get edited,
   * and the caller falls back to the computed overview. */
  get(groupId: string): DesignGroupOverview | undefined {
    return this.db.select().from(designGroupOverviews).where(eq(designGroupOverviews.groupId, groupId)).get() as DesignGroupOverview | undefined;
  }

  /** Insert or overwrite -- there is at most one current override per group,
   * not a history, matching how a design's own `summary` is a single
   * mutable field rather than a log. */
  save(groupId: string, overview: string, revisedBy: string): DesignGroupOverview {
    const row: DesignGroupOverview = { groupId, overview, revisedBy, revisedAt: Date.now() };
    this.db.insert(designGroupOverviews).values(row).onConflictDoUpdate({ target: designGroupOverviews.groupId, set: { overview, revisedBy, revisedAt: row.revisedAt } }).run();
    return row;
  }
}
