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
 * **Compute-on-read, cached, never persisted.** A design has an owner whose
 * `owner_edit`/`rephrase_accepted` text the automatic path must never touch
 * (`isHumanWritten`); a *group* has no such owner and no row of its own --
 * `groupId` is a label column on `designs`, not an entity. Inventing a
 * group-owned row to hold this text would need its own authorship/edit
 * story this feature doesn't have yet. So this follows `proposalCache`'s
 * precedent exactly: computed, cached by a key that is exact in what state
 * it describes, served straight from the cache on a repeat read, recomputed
 * the moment any member changes. A restart empties it; the next read just
 * recomputes.
 */

import type { DesignStatement } from "@twing/core";

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
  callModel: (systemPrompt: string, userPrompt: string) => Promise<string>;
  /** A human-saved override for this group (2026-10-10), if anyone has ever
   * edited it -- `design-group-store.ts`'s `DesignGroupStore.get`, narrowed
   * to the one field this needs. Checked before anything else in both
   * propose functions below: once a person has written the words, nothing
   * automatic generates new ones to replace them, the same rule
   * `isHumanWritten` enforces per-design. */
  getOverride?: (groupId: string) => string | undefined;
  log?: (message: string) => void;
}

const SYSTEM_PROMPT = [
  "You are writing ONE overview for a change that spans multiple repositories, linked because they are one piece of work.",
  "",
  "You are given each repo's own current design overview, labeled with its repo name, and -- when available -- grounding from the conversation that produced each one.",
  "",
  "Write the combined overview as up to three short, labeled lines, same shape as a single design's overview. Omit a line that adds nothing:",
  "",
  "What: one sentence -- the single unified goal, written as if this were one change, because it is. Always required.",
  "Approach: only if there is a real cross-repo decision or tradeoff worth recording.",
  "Touches: name a repo inline only where it adds information a reader needs -- e.g. 'the server validates it, the CLI prints it'. Never a bullet list of repos, and never restate a repo if What already makes its role obvious.",
  "",
  "Rules:",
  "- Present tense, short, no headings, no bullet points, no per-repo changelog.",
  "- If the repos are genuinely doing unrelated things under one groupId, say so plainly rather than inventing a unifying thread that isn't there.",
  "- Output just the labeled lines and nothing else: no preamble, no quotes, no explanation.",
].join("\n");

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
function groupCacheKey(members: DesignStatement[]): string {
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
 * Computes (or returns the cached) combined overview for a group. **Writes
 * nothing** -- there is nowhere to write it to; see this file's header.
 *
 * Returns `undefined` when there's nothing to combine (zero or one visible
 * member -- not actually a group from this caller's vantage point) or when
 * the model call fails, same fail-soft rule as `proposeOverview`: a group
 * overview failing never degrades or blanks any individual design's own
 * text.
 */
export async function proposeGroupOverview(deps: GroupResynthesisDeps, groupId: string): Promise<string | undefined> {
  const override = deps.getOverride?.(groupId);
  if (override !== undefined) return override;
  return proposeOverviewForMembers(deps, deps.listMembers(groupId));
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
  if (members.length < 2) return undefined;

  // Every member shares the same `groupId` by construction (that's the
  // query that found them), so any one of them names it.
  const groupId = members[0].groupId;
  const override = groupId ? deps.getOverride?.(groupId) : undefined;
  if (override !== undefined) return override;

  const key = groupCacheKey(members);
  const cached = cachedGroupProposal(key);
  if (cached !== undefined) return cached;

  try {
    const out = await deps.callModel(SYSTEM_PROMPT, buildUserPrompt(deps, members));
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
