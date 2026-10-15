/**
 * Group-level state that's persisted: the final overview and the final
 * diagrams for a `groupId` (2026-10-15; until then only a human-written
 * overview was saved, and everything else was computed on every read and
 * cached in memory). The monitor renders both straight from the design
 * payload, so opening a design shows its final text at once instead of the
 * raw stored overview followed by a swap. See `db/schema.ts`.
 */

import { eq } from "drizzle-orm";
import type { DesignDiagram } from "./design-diagrams.js";
import { designGroupDiagrams, designGroupOverviews } from "./db/schema.js";
import type { Db } from "./db/client.js";

export interface DesignGroupOverview {
  groupId: string;
  overview: string;
  revisedBy: string;
  revisedAt: number;
  /** Who wrote it last: a person's edit, or twing's resynthesis (2026-10-15). */
  source: "human" | "twing";
  /** The member state it was written for (`groupCacheKey`); "" on a row
   * saved before this column existed. */
  stateKey: string;
}

export interface DesignGroupDiagrams {
  groupId: string;
  stateKey: string;
  diagrams: DesignDiagram[];
  skipped?: string;
  generatedAt: number;
}

export class DesignGroupStore {
  constructor(private readonly db: Db) {}

  /** The human-authored override for this group, if anyone has ever saved
   * one. `undefined` is the ordinary case -- most groups never get edited,
   * and the caller falls back to the computed overview. */
  get(groupId: string): DesignGroupOverview | undefined {
    return this.db.select().from(designGroupOverviews).where(eq(designGroupOverviews.groupId, groupId)).get() as DesignGroupOverview | undefined;
  }

  /** Insert or overwrite -- there is at most one current overview per
   * group, not a history, matching how a design's own `summary` is a single
   * mutable field rather than a log. A person's edit and twing's
   * resynthesis write the same row; the latest one wins. */
  save(groupId: string, overview: string, revisedBy: string, source: DesignGroupOverview["source"], stateKey: string): DesignGroupOverview {
    const row: DesignGroupOverview = { groupId, overview, revisedBy, revisedAt: Date.now(), source, stateKey };
    this.db
      .insert(designGroupOverviews)
      .values(row)
      .onConflictDoUpdate({ target: designGroupOverviews.groupId, set: { overview, revisedBy, revisedAt: row.revisedAt, source, stateKey } })
      .run();
    return row;
  }

  /** The saved final diagrams for this group (2026-10-15), if any. */
  getDiagrams(groupId: string): DesignGroupDiagrams | undefined {
    const row = this.db.select().from(designGroupDiagrams).where(eq(designGroupDiagrams.groupId, groupId)).get();
    if (!row) return undefined;
    return { groupId: row.groupId, stateKey: row.stateKey, diagrams: JSON.parse(row.diagrams) as DesignDiagram[], ...(row.skipped ? { skipped: row.skipped } : {}), generatedAt: row.generatedAt };
  }

  saveDiagrams(groupId: string, stateKey: string, diagrams: DesignDiagram[], skipped?: string): void {
    const values = { groupId, stateKey, diagrams: JSON.stringify(diagrams), skipped: skipped ?? null, generatedAt: Date.now() };
    this.db
      .insert(designGroupDiagrams)
      .values(values)
      .onConflictDoUpdate({ target: designGroupDiagrams.groupId, set: { stateKey, diagrams: values.diagrams, skipped: values.skipped, generatedAt: values.generatedAt } })
      .run();
  }
}
