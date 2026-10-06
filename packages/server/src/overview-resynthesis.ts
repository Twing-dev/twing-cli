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
  if (design.overviewRevisionSource !== "owner_edit") {
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
  return events.filter((e) => e.kind === "design_amended" && e.ts > since).length;
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
  if (design.overviewRevisionSource === "owner_edit") return "human_wrote_it";
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
  "You are given the design's ORIGINAL overview and, in order, the AMENDMENTS its author appended as the work changed.",
  "Write ONE current overview: what the design is doing now, as if written fresh today.",
  "",
  "Rules:",
  "- Present tense. No dates, no 'Update:', no changelog, no mention of amendments or of this rewrite.",
  "- A later amendment that contradicts the original wins. State the current position only; do not narrate the change.",
  "- Keep every distinct piece of scope the text mentions. Dropping a commitment is the one unacceptable failure.",
  "- Drop duplicates: amendments are often pasted twice.",
  "- Omit bare lists of change ids or PR links. Those are recorded structurally elsewhere.",
  "- One to three short paragraphs. Plain prose, no headings, no bullet points.",
  "- Output the overview itself and nothing else: no preamble, no quotes around it, no explanation.",
].join("\n");

/** Cap on what reaches the model. Generous -- the overview route already
 * refuses a summary over 8000 characters -- but an amendment log is unbounded
 * in principle and a prompt should not be. */
const MAX_INPUT_CHARS = 24_000;

function buildUserPrompt(original: string, amendments: string[]): string {
  const parts = [`ORIGINAL OVERVIEW:\n${original}`];
  amendments.forEach((text, i) => parts.push(`AMENDMENT ${i + 1}:\n${text}`));
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

  const original = originalText(design);
  try {
    const out = await deps.callModel(SYSTEM_PROMPT, buildUserPrompt(original, amendments));
    const text = out.trim();
    // A model that returns nothing usable is the same case as one that
    // throws. Checked rather than trusted, because an empty string would pass
    // straight through `reviseOverview` and blank the design.
    if (text.length === 0) return undefined;
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
