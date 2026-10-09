/**
 * Folding a design's amendment pile back into one current overview
 * (2026-10-06).
 *
 * `amend` appends: `appendSummaryUpdate` (design-checks.ts) glues each
 * amendment onto `summary` as a dated `Update (date):` entry and nothing
 * ever collapses it. Observed on a real design: 3301 characters of summary
 * of which 326 were the original intent, five amendments, two of them byte
 * identical, one a list of change ids already held structurally in
 * `changes[]`. A reviewer cannot tell the design's current position from its
 * edit history.
 *
 * ## What this deliberately does not do
 *
 * **It does not stop the append.** An earlier plan deleted
 * `appendSummaryUpdate` outright; this one leaves it exactly as it is. The
 * appended text is the audit record, it keeps the amend route synchronous
 * and free of a model call, and -- most load-bearing -- every review comment
 * is anchored to a quote plus an offset *into that string*
 * (`design-comment-anchor.ts`). Rewriting is therefore a destructive act
 * dressed as a tidy-up, and it is gated accordingly below.
 *
 * It also adds no revision mechanism of its own: the single write goes
 * through `DesignRegistry.reviseOverview`, whose own doc comment already
 * names "an LLM resynthesis, a session-close fold" as an expected caller.
 *
 * ## Two speeds, deliberately different
 *
 * - `proposeOverview` **computes and returns text; it never writes.** That
 *   is what the Rewrite button calls. The owner reads the proposal, edits
 *   it, and saves through the normal overview route -- so the accepted text
 *   lands as `owner_edit`, by a human, with that route's own validation.
 * - `enqueueResynthesis` is the automatic path: close (also the SessionEnd
 *   hook's route) and the amendment threshold. It writes, so it carries
 *   every guard in `shouldResynthesize`.
 *
 * Both build their input the same way, from stored state only, so an
 * automatic run and a button press on the same design produce the same
 * proposal.
 */

import type { DesignStatement } from "@twing/core";
import type { ActivityEvent } from "./activity-log.js";

/** How many amendments may pile up before the automatic path takes an
 * interest.
 *
 * Three, not one: a design amended once reads perfectly well, and rewriting
 * it spends a model call plus the anchor risk below to no benefit. By three
 * the overview is a statement followed by a changelog, which is the shape
 * this exists to fix. A length-based rule ("the appended text now outweighs
 * the original") would catch two very long amendments as well, and is the
 * obvious second condition if counting alone proves to miss. */
export const AMENDMENT_THRESHOLD = 3;

/** How long the threshold trigger waits before running.
 *
 * The deny -> amend -> retry loop fires in bursts of seconds, so running on
 * the amendment that crosses the line would start a rewrite that the next
 * amendment immediately invalidates. Coalescing the burst costs a few
 * seconds of staleness on a background job nobody is waiting for. */
export const DEBOUNCE_MS = 12_000;

/** Why a run was asked for -- carried into the log line so an operator can
 * tell a close-driven rewrite from a threshold-driven one without
 * correlating timestamps. */
export type ResynthesisReason = "design_closed" | "amendment_threshold" | "manual";

/** Everything the job reads. An object rather than positional arguments
 * because the call sites are the route and two triggers, all of which have
 * these to hand under these names. */
export interface ResynthesisDeps {
  getDesign: (id: string) => DesignStatement | undefined;
  /** Every event ever written against this design (`eventsForRelatedId`).
   * Filtered here rather than by the caller, so the filter lives next to the
   * reasoning about what counts as an amendment. */
  eventsFor: (designId: string) => ActivityEvent[];
  /** Open review comments decide whether an automatic rewrite may proceed at
   * all -- see `shouldResynthesize`. */
  commentsFor: (designId: string) => { status: string; anchor?: { field: string } }[];
  /** Injected so tests can run the whole job without a provider, and so the
   * model id is resolved once at app construction rather than per call. */
  callModel: (systemPrompt: string, userPrompt: string) => Promise<string>;
  /** `designs.reviseOverview`, narrowed to what this needs. */
  writeOverview: (id: string, summary: string) => void;
  /** Budgeted, redacted conversation grounding for this design, when its
   * session was captured and held something -- `undefined` otherwise
   * (never captured, captured but empty, or a read failure). Optional so
   * tests that don't care about grounding can omit it entirely; the prompt
   * simply states absence rather than forcing every caller to wire a store
   * through just to pass `undefined` explicitly. */
  groundingFor?: (design: DesignStatement) => string | undefined;
  /** Overridable for tests; `console.log` in production, matching every
   * other job in this package. */
  log?: (message: string) => void;
}

/** Why a run was refused, or `undefined` when it may go ahead. Returned
 * rather than thrown: every one of these is an ordinary, expected outcome,
 * and the caller's job is to log it and move on. */
export type ResynthesisRefusal =
  | "no_such_design"
  | "human_wrote_it"
  | "open_anchored_comments"
  | "not_enough_amendments"
  | "design_moved";

/** Revision sources that mean **a person decided on this text** -- either by
 * writing it or by reading a proposal and accepting it (2026-10-06).
 *
 * The distinction that matters everywhere below is human-vs-machine, not
 * owner-vs-anyone: `rephrase_accepted` can be written by any project member,
 * and it still represents somebody having read the words and chosen them. */
export const HUMAN_REVISION_SOURCES = ["owner_edit", "rephrase_accepted"] as const;

export function isHumanWritten(design: DesignStatement): boolean {
  return (HUMAN_REVISION_SOURCES as readonly string[]).includes(design.overviewRevisionSource ?? "");
}

/** How much drift it takes before the **button** offers a rephrase.
 *
 * Two numbers, and the difference is the whole policy: nobody is attached to
 * prose a machine wrote unattended, so one amendment is enough to make
 * folding it worthwhile. Text a person wrote -- or read and accepted -- is
 * theirs, and rewriting a paragraph of it to absorb a single line is a bad
 * trade. At two it has genuinely drifted.
 *
 * Both sit below `AMENDMENT_THRESHOLD`, which gates the *automatic* path: a
 * person choosing to press a button is a lower bar than a machine deciding
 * on its own, and the automatic path additionally never touches human text
 * at all (`shouldResynthesize`). */
export const MANUAL_THRESHOLD_MACHINE_TEXT = 1;
export const MANUAL_THRESHOLD_HUMAN_TEXT = 2;

/** Why the rephrase button is offered, or is offered but inert. Returned
 * rather than a bare boolean so the dashboard and the route agree on the
 * reason, and the reason is what the user is actually shown. */
export type RephraseAvailability = { allowed: true } | { allowed: false; reason: "nothing_new" | "human_text_barely_changed" };

/**
 * Whether pressing rephrase would do anything, given the overview's state.
 *
 * Deliberately says nothing about *who is asking*. Anyone may rephrase any
 * design they can see; what decides whether it acts is how far the overview
 * has drifted from the text somebody last settled on. Enforced here as well
 * as in the dashboard, since a disabled button is a courtesy and not a
 * control.
 */
export function rephraseAvailability(design: DesignStatement, events: ActivityEvent[]): RephraseAvailability {
  const since = amendmentsSinceOverview(design, events);
  const needed = isHumanWritten(design) ? MANUAL_THRESHOLD_HUMAN_TEXT : MANUAL_THRESHOLD_MACHINE_TEXT;
  if (since >= needed) return { allowed: true };
  return { allowed: false, reason: isHumanWritten(design) ? "human_text_barely_changed" : "nothing_new" };
}

/**
 * Proposals already computed, keyed by the exact design state they describe.
 *
 * The key is what makes this correct with no expiry: an amendment moves
 * `scopeVersion` and a save moves `overviewRevision`, so the moment anything
 * about the design changes, the next lookup misses and the model runs again.
 * Age never makes a cached proposal wrong -- change does, and change is in
 * the key.
 *
 * Bounded by count rather than by time. An entry whose design has since moved
 * is unreachable but still resident, so without a bound this grows forever;
 * with one, the dead entries fall out oldest-first. A proposal is a couple of
 * kilobytes, so a few hundred costs well under a megabyte.
 *
 * In-process, so a restart empties it -- the same trade `ResynthesisQueue`
 * makes, and worth no more than one extra model call.
 */
const PROPOSAL_CACHE_MAX = 200;
const proposalCache = new Map<string, string>();

function cacheKey(design: DesignStatement): string {
  return `${design.id}:${design.scopeVersion}:${design.overviewRevision ?? 0}`;
}

export function cachedProposal(design: DesignStatement): string | undefined {
  const key = cacheKey(design);
  const hit = proposalCache.get(key);
  // Re-inserted on read so the Map's own insertion order doubles as the LRU
  // ordering -- the oldest *untouched* entry is the one evicted below.
  if (hit !== undefined) {
    proposalCache.delete(key);
    proposalCache.set(key, hit);
  }
  return hit;
}

function rememberProposal(design: DesignStatement, proposal: string): void {
  proposalCache.set(cacheKey(design), proposal);
  while (proposalCache.size > PROPOSAL_CACHE_MAX) {
    const oldest = proposalCache.keys().next().value;
    if (oldest === undefined) break;
    proposalCache.delete(oldest);
  }
}

/** For tests, and for anything that ever needs to prove a call was made. */
export function __clearProposalCache(): void {
  proposalCache.clear();
}

/** The dated-entry marker `appendSummaryUpdate` writes. Kept in step with
 * that function and with twing-monitor's `lib/amendments.ts`, which splits
 * the same string for display. */
const MARKER = /\n\nUpdate \((\d{4}-\d{2}-\d{2})\): /g;

/** The design's own text: everything before the first appended entry. The
 * `summaryExtracted` column holds the *extraction-time* original and is
 * preferred when present, since a design whose overview was rewritten once
 * already has its pre-rewrite text there. */
export function originalText(design: DesignStatement): string {
  // ...except after a human rewrote it. `summaryExtracted` is then the
  // *machine's* first draft, and preferring it would quietly throw away what
  // the owner wrote and rebuild from the text they replaced. Their words are
  // the base; the amendments that landed on top are what needs folding in.
  // Reachable from the Rewrite button only -- the automatic path refuses an
  // `owner_edit` design outright (`shouldResynthesize`) -- which is exactly
  // the case the monitor's nudge exists to offer.
  if (!isHumanWritten(design)) {
    const extracted = design.summaryExtracted?.trim();
    if (extracted) return extracted;
  }
  const summary = design.summary ?? "";
  const first = [...summary.matchAll(MARKER)][0];
  return first ? summary.slice(0, first.index) : summary;
}

/** Each amendment's own text, oldest first.
 *
 * Split out of `summary` rather than read from the events, because the
 * merged string is the one thing guaranteed to carry every amendment: a
 * `design_amended` payload holds the *whole* summary as it stood after that
 * amend (`newSummary`), not the delta, so reconstructing the deltas from
 * events means diffing strings to recover what splitting already gives
 * exactly. The events still decide *how many* have landed since the last
 * rewrite -- see `amendmentsSinceOverview`, which is a different question. */
export function amendmentTexts(design: DesignStatement): string[] {
  const summary = design.summary ?? "";
  const matches = [...summary.matchAll(MARKER)];
  return matches.map((match, i) => {
    const start = match.index + match[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : summary.length;
    return summary.slice(start, end).trim();
  });
}

/** How many amendments have landed since the overview was last made clean.
 *
 * Counted from `design_amended` events newer than `overviewRevisedAt`, not
 * from the markers in `summary`: after a rewrite the markers are gone, so
 * counting those would reset to zero and never trip again on a design that
 * keeps being amended. A design never revised compares against 0, which is
 * every event it has. */
export function amendmentsSinceOverview(design: DesignStatement, events: ActivityEvent[]): number {
  const since = design.overviewRevisedAt ?? 0;
  const fromEvents = events.filter((e) => e.kind === "design_amended" && e.ts > since).length;
  // ...and the markers still standing in the summary, whichever is greater.
  //
  // Neither source is sufficient alone. Events are what survive a rewrite:
  // the markers are folded away, so counting those would reset to zero and
  // never trip again on a design that keeps being amended. Markers are what
  // survive *missing events*: a design carrying `Update (date):` entries with
  // no matching rows -- a legacy row, a pruned log -- visibly has a pile to
  // fold, and refusing to fold it because the log is thin would be absurd.
  //
  // It also keeps this in step with twing-monitor, which counts the markers
  // it can see (`lib/amendments.ts`). Were the two to disagree, the dashboard
  // would offer a button the server then refuses -- so the server counts at
  // least whatever the reader is looking at.
  const fromMarkers = amendmentTexts(design).length;
  return Math.max(fromEvents, fromMarkers);
}

/**
 * Whether the automatic path may rewrite this design, and if not, why.
 *
 * The two refusals that matter:
 *
 * - **`human_wrote_it`.** Once an owner has written the overview themselves
 *   (`overviewRevisionSource === "owner_edit"`) nothing automatic touches it
 *   again, however many amendments pile on top. `reviseOverview`'s own doc
 *   comment names this as the guard's purpose. The monitor nudges the owner
 *   instead -- it can see the same two fields and needs no server flag.
 * - **`open_anchored_comments`.** A rewrite moves the exact text open review
 *   comments are anchored into, and they would all go stale at once, on a
 *   design somebody is in the middle of reviewing. So the job waits. Not a
 *   permanent refusal: the next trigger re-checks, and comments do get
 *   resolved.
 *
 * `manual` skips the threshold only. A human asking for a rewrite of a
 * twice-amended design is a legitimate request; a human asking to overwrite
 * someone's live review anchors is still not.
 */
export function shouldResynthesize(
  design: DesignStatement | undefined,
  events: ActivityEvent[],
  comments: { status: string; anchor?: { field: string } }[],
  reason: ResynthesisReason,
): ResynthesisRefusal | undefined {
  if (!design) return "no_such_design";
  if (isHumanWritten(design)) return "human_wrote_it";
  if (comments.some((c) => c.status === "open" && c.anchor?.field === "summary")) return "open_anchored_comments";
  // Closing is the moment the overview becomes the permanent record, so one
  // amendment is worth folding there; the threshold exists to stop the
  // *mid-flight* path running on every amend.
  if (reason === "amendment_threshold" && amendmentsSinceOverview(design, events) < AMENDMENT_THRESHOLD) {
    return "not_enough_amendments";
  }
  return undefined;
}

const SYSTEM_PROMPT = [
  "You are rewriting the overview of a software design statement.",
  "",
  "You are given the design's ORIGINAL overview, in order, the AMENDMENTS its author appended as the work changed, and -- when available -- an abridged, redacted transcript of the session that produced it.",
  "",
  "Write the current overview as up to three short, labeled lines. Most designs do not need all three -- omit a line that would add nothing for a change this size:",
  "",
  "What: one sentence -- what changes, for the user or the system. Always required.",
  "Approach: only if there is a real decision or tradeoff worth recording (one short sentence). Omit for a change with nothing to decide.",
  "Touches: only if naming where the change lives would actually help a reviewer (one short phrase -- files, components). Omit when it is a single obvious file or already implied by What.",
  "",
  "Rules:",
  "- Present tense. No dates, no 'Update:', no changelog, no mention of amendments or of this rewrite.",
  "- A later amendment that contradicts the original wins. State the current position only; do not narrate the change.",
  "- Keep every distinct piece of scope the text mentions. Dropping a commitment is the one unacceptable failure.",
  "- Drop duplicates: amendments are often pasted twice.",
  "- When a transcript is given, use it to make Approach specific -- a real reason that actually appears in it, never a guess. If the transcript doesn't explain the decision, leave Approach out rather than inventing one.",
  "- Short. A clause or a sentence per line, not a paragraph per line. A trivial change may be a single 'What:' line and nothing else.",
  "- Output just the labeled lines and nothing else: no preamble, no quotes, no explanation, no bullet characters.",
].join("\n");

/** Cap on what reaches the model. Generous -- the overview route already
 * refuses a summary over 8000 characters -- but an amendment log is unbounded
 * in principle and a prompt should not be. */
const MAX_INPUT_CHARS = 24_000;

function buildUserPrompt(original: string, amendments: string[], grounding?: string): string {
  const parts = [`ORIGINAL OVERVIEW:\n${original}`];
  amendments.forEach((text, i) => parts.push(`AMENDMENT ${i + 1}:\n${text}`));
  if (grounding) parts.push(`SESSION TRANSCRIPT (conversation that produced this; abridged and redacted):\n${grounding}`);
  return parts.join("\n\n").slice(0, MAX_INPUT_CHARS);
}

/**
 * Computes a proposed overview. **Writes nothing.**
 *
 * Returns `undefined` when there is nothing to propose (no amendments to
 * fold) or when the model fails. A failure here is never an error the caller
 * surfaces as one: the design keeps the text it has, the same fail-soft rule
 * extraction and the semantic check follow. An LLM outage must never blank a
 * design or block a close.
 *
 * Built from stored state only -- the original plus the full amendment list
 * -- and **never from a previous synthesis**. Feeding a rewrite back into a
 * rewrite is a telephone game in which detail decays silently and nobody can
 * point at the step that lost it.
 */
export async function proposeOverview(deps: ResynthesisDeps, designId: string): Promise<string | undefined> {
  const design = deps.getDesign(designId);
  if (!design) return undefined;

  const amendments = amendmentTexts(design);
  if (amendments.length === 0) return undefined;

  // The same design state always produces the same proposal, so a second
  // press -- by this reader or any other -- is answered from the cache rather
  // than by paying for the model again. See `proposalCache`.
  const cached = cachedProposal(design);
  if (cached !== undefined) return cached;

  const original = originalText(design);
  const grounding = deps.groundingFor?.(design);
  try {
    const out = await deps.callModel(SYSTEM_PROMPT, buildUserPrompt(original, amendments, grounding));
    const text = out.trim();
    // A model that returns nothing usable is the same case as one that
    // throws. Checked rather than trusted, because an empty string would pass
    // straight through `reviseOverview` and blank the design.
    if (text.length === 0) return undefined;
    rememberProposal(design, text);
    return text;
  } catch (err) {
    deps.log?.(`twing serve: design ${designId.slice(0, 8)} overview resynthesis failed -- keeping existing text (${String(err)})`);
    return undefined;
  }
}

/**
 * The automatic path: check the guards, compute, re-check, write.
 *
 * Exported un-debounced so tests can drive it directly and so `close` can use
 * it without waiting -- the design is finished, there is no burst to
 * coalesce. `ResynthesisQueue` is the debounced wrapper the amend path uses.
 */
export async function resynthesizeNow(
  deps: ResynthesisDeps,
  designId: string,
  reason: ResynthesisReason,
): Promise<ResynthesisRefusal | "written" | "no_proposal"> {
  const refusal = shouldResynthesize(deps.getDesign(designId), deps.eventsFor(designId), deps.commentsFor(designId), reason);
  if (refusal) {
    deps.log?.(`twing serve: design ${designId.slice(0, 8)} overview resynthesis skipped (${reason}: ${refusal})`);
    return refusal;
  }

  // Captured before the slow call, so the state the proposal describes can be
  // compared with the state it would land on. Same shape as
  // `runSemanticComparatorPass`'s guard in app.ts, for the same reason.
  const before = deps.getDesign(designId);
  if (!before) return "no_such_design";
  const startScope = before.scopeVersion;
  const startRevision = before.overviewRevision ?? 0;

  const proposal = await proposeOverview(deps, designId);
  if (!proposal) return "no_proposal";

  // Re-read: an amend or an owner edit may have landed during the call. The
  // guards run again rather than only the version check, because an owner
  // edit changes *whose text it is*, not merely how old it is.
  const after = deps.getDesign(designId);
  if (!after) return "no_such_design";
  if (after.scopeVersion !== startScope || (after.overviewRevision ?? 0) !== startRevision) {
    deps.log?.(`twing serve: design ${designId.slice(0, 8)} overview resynthesis discarded -- design moved while the model ran`);
    return "design_moved";
  }
  const lateRefusal = shouldResynthesize(after, deps.eventsFor(designId), deps.commentsFor(designId), reason);
  if (lateRefusal) {
    deps.log?.(`twing serve: design ${designId.slice(0, 8)} overview resynthesis discarded (${lateRefusal} appeared while the model ran)`);
    return lateRefusal;
  }

  deps.writeOverview(designId, proposal);
  deps.log?.(`twing serve: design ${designId.slice(0, 8)} overview resynthesised (${reason})`);
  return "written";
}

/**
 * Debounced, single-flight scheduling for the automatic path.
 *
 * In-process only, and deliberately so while this is the whole mechanism: a
 * restart loses pending timers, and the cost of that is an overview that
 * stays piled up until the next amendment or until the design closes. The
 * manual button is the recovery, and a design nothing ever touches again is
 * one nobody is reading either.
 *
 * Single-flight per design: a trigger arriving while a run is in flight marks
 * it dirty and re-runs once at the end, rather than starting a second model
 * call against the same row.
 */
export class ResynthesisQueue {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = new Set<string>();
  private dirty = new Set<string>();

  /** Public so the one caller that computes *without* scheduling -- the
   * Rewrite button's route -- shares exactly the deps the automatic path
   * uses, rather than app.ts building a second bundle that could drift. */
  constructor(
    readonly deps: ResynthesisDeps,
    private delayMs: number = DEBOUNCE_MS,
  ) {}

  /** Schedules a run. A second call for the same design before the timer
   * fires replaces it, which is what coalesces an amend burst. */
  enqueue(designId: string, reason: ResynthesisReason): void {
    const existing = this.timers.get(designId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(designId);
      void this.run(designId, reason);
    }, this.delayMs);
    // Never hold the process open for a background tidy-up: a CLI-hosted
    // coordinator should still exit when it is asked to.
    timer.unref?.();
    this.timers.set(designId, timer);
  }

  /** Runs immediately, skipping the debounce -- what `close` uses. */
  async run(designId: string, reason: ResynthesisReason): Promise<void> {
    if (this.running.has(designId)) {
      this.dirty.add(designId);
      return;
    }
    this.running.add(designId);
    try {
      await resynthesizeNow(this.deps, designId, reason);
    } finally {
      this.running.delete(designId);
    }
    if (this.dirty.delete(designId)) await this.run(designId, reason);
  }

  /** Cancels every pending timer. For tests and shutdown; a pending rewrite
   * is never worth blocking an exit on. */
  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
