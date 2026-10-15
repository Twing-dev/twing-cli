/**
 * One overview across every design sharing a `groupId` (2026-10-09).
 *
 * `overview-resynthesis.ts` folds one design's own amendment pile into one
 * clean overview. This folds *across* designs instead: a `groupId`-linked
 * change spanning several repos has, until now, shown a reviewer N separate
 * fragments with no combined statement of what the whole change is. This
 * produces that one statement, built from each member's already-clean
 * overview (so it composes with, rather than duplicates, per-design
 * resynthesis) plus each member's own conversation grounding when available.
 *
 * **Saved, latest writer wins** (2026-10-15). The full group's overview is
 * written to `design_group_overviews` with the member state it describes
 * (`groupCacheKey`), and served from there while that state holds -- so
 * the monitor can render it with the design itself, and a restart costs no
 * model call. A person's edit and this resynthesis write the same row: an
 * edit stands until a member changes, and then the refresh writes over it.
 * The in-memory cache below stays for viewers who see only part of a group
 * (their overview is built from what they can see and is never saved).
 */

import type { DesignStatement } from "@twing/core";
// Moved to llm-prompts.ts (2026-10-10), alongside every other prompt this
// server sends, so they can be read in one place -- see that file's header.
import { GROUP_OVERVIEW_RESYNTHESIS_PROMPT as SYSTEM_PROMPT } from "./llm-prompts.js";
import type { LlmTag } from "./llm-client.js";
import { planSectionFor } from "./overview-resynthesis.js";

export interface GroupResynthesisDeps {
  /** Every design sharing a `groupId`, as the caller is authorized to see.
   * Filtering by visibility is the caller's job (same split `GET
   * /v1/designs/:id` already makes for `groupMembers`) -- this module only
   * ever sees the set it should synthesize from. */
  listMembers: (groupId: string) => DesignStatement[];
  /** Same shape as `ResynthesisDeps.groundingFor` -- reused, not
   * reimplemented, so a group overview is grounded exactly the way a
   * single design's is. */
  groundingFor?: (design: DesignStatement) => string | undefined;
  /** A short, human-meaningful label for a member -- a repo name, not a
   * raw `projectId` hash. The model's job is to say *which* repo does what
   * when that's worth saying, and "b1d42b22" says nothing. */
  labelFor: (design: DesignStatement) => string;
  callModel: (systemPrompt: string, userPrompt: string, tag: LlmTag) => Promise<string>;
  /** The group's saved overview (2026-10-15) -- `DesignGroupStore.get`,
   * narrowed to what this needs. Served whenever `stateKey` matches the
   * members being asked about ("" is a row saved before state keys, kept
   * as-is), whether a person or twing wrote it. */
  getSaved?: (groupId: string) => { overview: string; stateKey: string } | undefined;
  /** Saves a freshly computed overview for the full group. */
  save?: (groupId: string, stateKey: string, overview: string) => void;
  /** Run after each refresh of a group (2026-10-15): the diagrams are
   * refreshed and saved in the same pass, so both are ready together. */
  afterRefresh?: (groupId: string) => Promise<unknown>;
  log?: (message: string) => void;
}


const MAX_INPUT_CHARS = 24_000;
/** Per-member cap inside the prompt -- grounding especially, so one heavily
 * -captured repo can't crowd out the others. Mirrors MAX_PLAN_CHARS's role
 * in overview-resynthesis.ts, just scoped per member instead of once. */
const MAX_MEMBER_CHARS = 6_000;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[… truncated …]` : text;
}

function buildUserPrompt(deps: GroupResynthesisDeps, members: DesignStatement[]): string {
  const parts = members.map((member) => {
    const label = deps.labelFor(member);
    const lines = [`REPO: ${label}`, `OVERVIEW:\n${truncate(member.summary ?? "", MAX_MEMBER_CHARS)}`];
    // The "how" (2026-10-11) -- without it the group overview could only
    // restate each member's problem. See `planSectionFor`.
    const plan = planSectionFor(member);
    if (plan) lines.push(`PLAN:\n${truncate(plan, MAX_MEMBER_CHARS)}`);
    const grounding = deps.groundingFor?.(member);
    if (grounding) lines.push(`SESSION CONTEXT:\n${truncate(grounding, MAX_MEMBER_CHARS)}`);
    return lines.join("\n\n");
  });
  return parts.join("\n\n---\n\n").slice(0, MAX_INPUT_CHARS);
}

/** Exact state a cached proposal describes: every member's id paired with
 * the two fields that move whenever anything about it changes (mirrors
 * `overview-resynthesis.ts`'s `cacheKey`), sorted so member order in
 * `listMembers`'s return never matters. */
export function groupCacheKey(members: DesignStatement[]): string {
  return members
    .map((m) => `${m.id}:${m.scopeVersion}:${m.overviewRevision ?? 0}`)
    .sort()
    .join("|");
}

const PROPOSAL_CACHE_MAX = 200;
const groupProposalCache = new Map<string, string>();

function cachedGroupProposal(key: string): string | undefined {
  const hit = groupProposalCache.get(key);
  if (hit !== undefined) {
    groupProposalCache.delete(key);
    groupProposalCache.set(key, hit);
  }
  return hit;
}

function rememberGroupProposal(key: string, proposal: string): void {
  groupProposalCache.set(key, proposal);
  while (groupProposalCache.size > PROPOSAL_CACHE_MAX) {
    const oldest = groupProposalCache.keys().next().value;
    if (oldest === undefined) break;
    groupProposalCache.delete(oldest);
  }
}

export function __clearGroupProposalCache(): void {
  groupProposalCache.clear();
}

/**
 * The current overview for a `groupId`, built from *every* member and saved
 * (2026-10-15) -- only call this where the reader may see the whole group.
 *
 * Every design has a `groupId` (its own id, when nothing else shares it), so
 * this runs uniformly whether the group has one member or several (2026-10-10
 * -- previously refused below two, which is why a standalone design used to
 * show its raw stored text while a linked group showed this computed one;
 * same pipeline for both now, so there's one view instead of two).
 *
 * Returns `undefined` when there are genuinely zero visible members (the
 * caller's own filtering left nothing, which `GET .../group-overview`'s
 * 404 already covers before this is ever reached) or when the model call
 * fails, same fail-soft rule as `proposeOverview`: this overview failing
 * never degrades or blanks any individual design's own stored text.
 */
export async function proposeGroupOverview(deps: GroupResynthesisDeps, groupId: string): Promise<string | undefined> {
  const members = deps.listMembers(groupId);
  const overview = await proposeOverviewForMembers(deps, members);
  if (overview === undefined || members.length === 0) return overview;
  const key = groupCacheKey(members);
  const saved = deps.getSaved?.(groupId);
  if (!saved || (saved.stateKey !== "" && saved.stateKey !== key)) deps.save?.(groupId, key, overview);
  return overview;
}

/**
 * Same computation, taking the member list directly rather than looking it
 * up via `deps.listMembers`.
 *
 * This is what `GET /v1/designs/:id/group-overview` calls, with a list
 * already filtered to what *that specific viewer* may see -- the same
 * per-sibling visibility filter `GET /v1/designs/:id` already applies to
 * `groupMembers` (a linked group can span projects; a sibling in a project
 * the caller can't see must be invisible to them here too, not folded into
 * a shared cached summary that leaks its existence). The cache key is
 * still exact in what it describes (`groupCacheKey`), so two viewers with
 * different visibility into the same group correctly miss each other's
 * cache entry rather than one leaking into the other's answer.
 *
 * The background trigger (`proposeGroupOverview`/`GroupResynthesisQueue`),
 * by contrast, deliberately computes from every member -- it has no
 * viewer, only keeps the cache warm for whoever reads next, and that
 * reader's own filtered call is what actually decides what reaches them.
 */
export async function proposeOverviewForMembers(deps: GroupResynthesisDeps, members: DesignStatement[]): Promise<string | undefined> {
  if (members.length < 1) return undefined;

  // Every member shares the same `groupId` by construction (that's the
  // query that found them), so any one of them names it.
  const groupId = members[0].groupId;
  const key = groupCacheKey(members);
  // Matches only when these are exactly the members it was saved for, so a
  // viewer who sees part of the group never gets the whole group's text.
  const saved = groupId ? deps.getSaved?.(groupId) : undefined;
  if (saved && (saved.stateKey === "" || saved.stateKey === key)) return saved.overview;

  // A group of one whose own overview has already been rewritten (by the
  // per-design resynthesis or by its owner) has nothing left to combine:
  // that text already is the overview, so showing it costs no second model
  // call (2026-10-11). An unrevised one -- e.g. a template design whose
  // summary is just its goal line -- still goes through the model, since
  // that is the only path that adds the solution to it.
  if (members.length === 1 && (members[0].overviewRevision ?? 0) > 0) return members[0].summary;

  const cached = cachedGroupProposal(key);
  if (cached !== undefined) return cached;

  try {
    const out = await deps.callModel(SYSTEM_PROMPT, buildUserPrompt(deps, members), {
      purpose: "group_overview_resynthesis",
      groupId,
      designIds: members.map((m) => m.id),
    });
    const text = out.trim();
    if (text.length === 0) return undefined;
    rememberGroupProposal(key, text);
    return text;
  } catch (err) {
    deps.log?.(`twing serve: group (${members.map((m) => m.id.slice(0, 8)).join(",")}) overview resynthesis failed -- ${String(err)}`);
    return undefined;
  }
}

/**
 * Debounced, single-flight scheduling for the automatic path, keyed by
 * `groupId` instead of `designId`. Same shape as `ResynthesisQueue` --
 * deliberately a separate small class rather than generalizing that one,
 * since the two keys (`designId`, `groupId`) are different namespaces and
 * conflating them would need a tag to tell them apart for no benefit.
 */
export class GroupResynthesisQueue {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = new Set<string>();
  private dirty = new Set<string>();

  constructor(
    readonly deps: GroupResynthesisDeps,
    private delayMs: number = 12_000,
  ) {}

  enqueue(groupId: string): void {
    const existing = this.timers.get(groupId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(groupId);
      void this.run(groupId);
    }, this.delayMs);
    timer.unref?.();
    this.timers.set(groupId, timer);
  }

  async run(groupId: string): Promise<void> {
    if (this.running.has(groupId)) {
      this.dirty.add(groupId);
      return;
    }
    this.running.add(groupId);
    try {
      await proposeGroupOverview(this.deps, groupId);
      await this.deps.afterRefresh?.(groupId);
    } catch (err) {
      this.deps.log?.(`twing serve: group ${groupId.slice(0, 8)} refresh failed -- ${String(err)}`);
    } finally {
      this.running.delete(groupId);
    }
    if (this.dirty.delete(groupId)) await this.run(groupId);
  }

  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
