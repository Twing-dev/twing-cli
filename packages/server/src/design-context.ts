/**
 * What a model is shown about a design (design review phase 2, 2026-09).
 *
 * Phase 1 answered a reviewer's question from the design alone: a summary, a
 * list of declared changes, some paths. That is what the agent *said* it
 * would do. This adds what the session actually did -- the conversation that
 * produced the design -- so "why 30s and not 10s?" can be answered with "the
 * author tried 10s first and hit the gateway timeout" instead of "the design
 * does not say".
 *
 * Three rules shape everything below.
 *
 * **1. The transcript never leaves the server.** This module returns a prompt
 * and a provenance summary. The prompt goes to the model; the provenance goes
 * to the reviewer. No route returns captured text, and none should: a
 * reviewer is entitled to an answer grounded in the session, not to read a
 * colleague's conversation.
 *
 * **2. Every captured turn is redacted again here.** What is on disk was
 * scrubbed by whatever version of `redact` shipped when it was written, and
 * `POST /v1/captures` accepts records from any authenticated client without
 * scrubbing them at all. While capture was a write-only sink a miss was
 * inert; now it feeds answers a whole project reads. See `redact`'s header in
 * core for the full argument.
 *
 * **3. Absence is stated, never silently filled.** A design whose repo never
 * opted into capture gets design-only grounding and says so; a conversation
 * that was cut says where and by how much. A model that cannot tell a gap
 * from a whole conversation will answer straight through it, and a reviewer
 * who cannot tell grounded from ungrounded will trust both equally.
 */

import { redact, type DesignStatement, type DesignChange } from "@twing/core";
import type { CaptureSlice, CaptureTurn } from "./capture-store.js";

/**
 * Total budget for everything sent to the model, in characters.
 *
 * ~48k characters is roughly 12k tokens -- comfortable on every model in
 * `PROVIDER_MODELS` with room for the answer, and deliberately not tuned to
 * the largest of them. A budget that only fits on the biggest model is one
 * that breaks the moment an operator points
 * `TWING_<PROVIDER>_COMMENT_ANSWER_MODEL` at something cheaper.
 */
export const MAX_CONTEXT_CHARS = 48_000;

/** What a caller must hold back from `MAX_CONTEXT_CHARS` for its own system
 * prompt. Both system prompts in `design-comment-answer.ts` are a little
 * over 2k; this is rounded up so a prompt edit does not silently push the
 * total over. */
export const SYSTEM_PROMPT_RESERVE = 3_000;

/** Per-turn cap inside the session transcript. Keeps one pasted stack trace
 * from consuming the budget and eliding the rest of the conversation. */
const MAX_TURN_CHARS = 1_500;

/** Cap on the design's own plan prose. `rawPlanExcerpt` carries an entire
 * `ExitPlanMode` plan verbatim and has no upstream cap. */
const MAX_PLAN_CHARS = 8_000;

/** Share of the budget the session transcript may take. The design is the
 * thing being reviewed and always comes first; the conversation is context
 * for it, however interesting. */
const TRANSCRIPT_BUDGET_FRACTION = 0.55;

const DESIGN_ELIDED_MARKER = "[… the rest of this design's declaration was too long to include …]";

/**
 * What the reviewer is told about where an answer came from.
 *
 * Deliberately small and free of transcript content: this is the part that
 * crosses the wire, so it carries counts and ids, never text. "Grounded in 32
 * of 138 turns" is what makes an answer auditable without publishing the
 * conversation behind it.
 */
export interface ContextProvenance {
  /** False when this design's session was never captured -- the repo never
   * opted in. The UI must say so rather than let an ungrounded answer look
   * like a grounded one. */
  captured: boolean;
  sessionId: string;
  totalTurns: number;
  turnsUsed: number;
  /** Turns dropped to fit the budget or the read window. */
  turnsElided: number;
  /** Which of the design's declared paths the session was observed touching
   * -- the honest answer to whether this conversation had anything to do with
   * this design. */
  touchedPaths: string[];
  /** Declared paths the session never touched. Present because its absence is
   * informative: a design whose files never appear in its own session is
   * worth a reviewer's suspicion. */
  untouchedPaths: string[];
}

export interface AssembledContext {
  /** The prompt body. Server-side only -- never returned by a route. */
  context: string;
  provenance: ContextProvenance;
}

function renderChange(change: DesignChange): string {
  const from = change.from ? ` (from ${change.from})` : "";
  const kind = change.kind && change.kind !== "code" ? ` [${change.kind}]` : "";
  return `- ${change.action}${kind} ${change.target}${from}: ${change.intent}`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[… truncated …]` : text;
}

/** Every path a design declares, in the spelling the design uses -- what
 * `CaptureStore.read` matches its `focusPaths` against. A `changes` target
 * can name a symbol (`src/x.ts::Thing.method`), so it is cut back to the
 * file, which is the granularity a capture records. */
export function designScopePaths(design: DesignStatement): string[] {
  const fromChanges = (design.changes ?? []).map((change) => change.target.split("::")[0]);
  return [...new Set([...design.creates, ...design.touches, ...fromChanges])].filter((p) => p.length > 0);
}

/**
 * The design itself, which is never trimmed away entirely.
 *
 * Structured `changes` supersede the flat `creates`/`touches` lists when
 * present rather than sitting alongside them: the two are the same
 * information (`creates`/`touches` are *derived* from `changes`, see
 * `deriveScope` in core), and printing both spends budget saying everything
 * twice.
 */
function designSections(design: DesignStatement): string[] {
  const sections = [`DESIGN SUMMARY:\n${design.summary}`];
  const changes = design.changes ?? [];

  if (changes.length > 0) {
    sections.push(`DECLARED CHANGES:\n${changes.map(renderChange).join("\n")}`);
  } else {
    if (design.creates.length > 0) sections.push(`CREATES: ${design.creates.join(", ")}`);
    if (design.touches.length > 0) sections.push(`TOUCHES: ${design.touches.join(", ")}`);
  }
  if (design.dependsOn.length > 0) sections.push(`DEPENDS ON: ${design.dependsOn.join(", ")}`);

  // Only when there is no structured declaration -- for a design that has
  // one, the plan text is the same thing again in prose.
  if (design.rawPlanExcerpt && changes.length === 0) {
    sections.push(`ORIGINAL PLAN TEXT:\n${truncate(design.rawPlanExcerpt, MAX_PLAN_CHARS)}`);
  }
  return sections;
}

/**
 * The session transcript: redacted, capped, and cut to a budget with every
 * gap stated where it happened.
 *
 * Gaps are placed by index rather than summed into one number at the end. A
 * slice that kept turns 0-2 and 96-110 was cut in one specific place, and
 * saying so *there* is the difference between a model reading a conversation
 * with a hole in it and a model reading what it believes is a whole one.
 */
function renderTranscript(turns: CaptureTurn[], budget: number): { text: string; turnsUsed: number } {
  if (turns.length === 0 || budget <= 0) return { text: "", turnsUsed: 0 };

  const render = (turn: CaptureTurn) => {
    const role = turn.record.role === "user" ? "DEVELOPER" : "AGENT";
    const raw = typeof turn.record.text === "string" ? turn.record.text : "";
    // Redacted before anything else happens to it -- see this file's header.
    return `${role}: ${truncate(redact(raw), MAX_TURN_CHARS)}`;
  };

  // **Both ends get a reserved share.** Filling the budget oldest-first --
  // which this did -- spends it all on the opening of a long session and
  // drops everything after: a 300-turn conversation rendered as its first 17
  // turns, with the entire recent half silently gone. That defeats the whole
  // reason the reader keeps a tail at all. Splitting the budget means the
  // conversation is cut in the middle, where a gap is least damaging and is
  // marked, rather than at the point the reviewer most likely cares about.
  const half = Math.floor(budget / 2);
  const head: { line: string; turn: CaptureTurn }[] = [];
  const tail: { line: string; turn: CaptureTurn }[] = [];

  let i = 0;
  let used = 0;
  while (i < turns.length) {
    const line = render(turns[i]);
    if (used + line.length + 2 > half) break;
    head.push({ line, turn: turns[i] });
    used += line.length + 2;
    i++;
  }

  let j = turns.length - 1;
  let usedTail = 0;
  // Leave room for the marker itself: an elision nobody can see is the
  // silent truncation this whole module is written against.
  const tailBudget = budget - used - ELISION_RESERVE;
  while (j >= i) {
    const line = render(turns[j]);
    if (usedTail + line.length + 2 > tailBudget) break;
    tail.unshift({ line, turn: turns[j] });
    usedTail += line.length + 2;
    j--;
  }

  const lines: string[] = [];
  let previousIndex = -1;
  for (const entry of [...head, ...tail]) {
    const gap = previousIndex >= 0 ? entry.turn.index - previousIndex - 1 : 0;
    if (gap > 0) lines.push(`[… ${gap} turn${gap === 1 ? "" : "s"} elided …]`);
    lines.push(entry.line);
    previousIndex = entry.turn.index;
  }

  return { text: lines.join("\n\n"), turnsUsed: head.length + tail.length };
}

/** Room held back for one elision marker, so the cut is always visible. */
const ELISION_RESERVE = 60;

/**
 * Assembles the prompt body for one design, grounded in its session when
 * there is one.
 *
 * `capture` is passed in rather than read here so this stays a pure function:
 * the routes own the store, and a test can assemble against a fixture without
 * touching a filesystem.
 */
export function assembleDesignContext(design: DesignStatement, capture: CaptureSlice | undefined, options: { budgetChars?: number } = {}): AssembledContext {
  // Caller-supplied, because grounding is never the whole prompt: an
  // answerer adds a system prompt, the thread so far and the live question
  // on top. Each part policing its own budget meant the *sum* had none --
  // measured at 96k characters against a stated 48k for a chat. The caller
  // reserves what it needs and asks for the rest.
  const budget = Math.max(0, options.budgetChars ?? MAX_CONTEXT_CHARS);
  const scope = designScopePaths(design);
  const sections = designSections(design);
  const touchedPaths = capture?.touchedFocusPaths ?? [];
  const untouchedPaths = scope.filter((p) => !touchedPaths.includes(p));

  if (!capture || capture.turns.length === 0) {
    // Stated, not implied. A reviewer reading an answer needs to know it came
    // from the design alone, and the model needs to know not to pretend
    // otherwise.
    sections.push(
      capture
        ? "SESSION TRANSCRIPT: this session was captured but holds no conversation. Answer from the design alone, and say so if the design does not cover the question."
        : "SESSION TRANSCRIPT: not available -- this repository has not opted into session capture, so the conversation behind this design was never recorded. Answer from the design alone, and say so if the design does not cover the question.",
    );
    return {
      context: fitToBudget(sections, budget),
      provenance: {
        captured: !!capture,
        sessionId: capture?.sessionId ?? design.sessionId,
        totalTurns: capture?.totalTurns ?? 0,
        turnsUsed: 0,
        turnsElided: capture?.totalTurns ?? 0,
        touchedPaths,
        untouchedPaths,
      },
    };
  }

  const spent = sections.reduce((n, section) => n + section.length + 2, 0);
  const transcriptBudget = Math.max(0, Math.min(budget * TRANSCRIPT_BUDGET_FRACTION, budget - spent - 500));
  const rendered = renderTranscript(capture.turns, transcriptBudget);

  if (rendered.text.length > 0) {
    sections.push(
      [
        "SESSION TRANSCRIPT (the conversation that produced this design; redacted, and abridged to fit).",
        `${capture.totalTurns} turns in total -- what follows is a subset, with every gap marked.`,
        touchedPaths.length > 0
          ? `This session was observed touching: ${touchedPaths.join(", ")}.`
          : "This session was not observed touching any of the files this design declares, which may itself be worth noting.",
        "",
        rendered.text,
      ].join("\n"),
    );
  }

  return {
    context: fitToBudget(sections, budget),
    provenance: {
      captured: true,
      sessionId: capture.sessionId,
      totalTurns: capture.totalTurns,
      turnsUsed: rendered.turnsUsed,
      turnsElided: Math.max(0, capture.totalTurns - rendered.turnsUsed),
      touchedPaths,
      untouchedPaths,
    },
  };
}

/**
 * Final guard on the whole assembled body.
 *
 * The transcript budget above cannot cover a design whose own declaration
 * exceeds the budget -- one declaring hundreds of changes does it with no
 * conversation at all. The marker's room is reserved *before* slicing:
 * slicing to the budget and then asking a truncate helper to cut at that same
 * budget produces a string of exactly that length, whose "was this too long?"
 * test is false, so the marker never appears and the cut is silent. That
 * exact bug shipped here once already.
 */
function fitToBudget(sections: string[], budget: number): string {
  const assembled = sections.join("\n\n");
  if (assembled.length <= budget) return assembled;
  // Too small even to say that it was cut: emit nothing rather than a marker
  // that itself breaks the budget. Unreachable through the real callers
  // (`groundingBudgetFor` floors grounding well above this) -- this is so a
  // pathological budget under-fills instead of over-filling.
  if (budget < DESIGN_ELIDED_MARKER.length + 2) return "";
  const room = budget - DESIGN_ELIDED_MARKER.length - 2;
  return `${assembled.slice(0, room)}\n${DESIGN_ELIDED_MARKER}`;
}

/**
 * One line a reviewer sees under an answer, saying what it was grounded in.
 *
 * Counts and ids only -- this crosses the wire, and the transcript does not.
 */
export function describeProvenance(provenance: ContextProvenance): string {
  if (!provenance.captured) {
    return "Answered from the design alone — this repository has not opted into session capture, so the conversation behind this design was never recorded.";
  }
  if (provenance.turnsUsed === 0) {
    return `Answered from the design alone — session ${provenance.sessionId.slice(0, 8)} was captured but held no usable conversation.`;
  }
  const declared = provenance.touchedPaths.length + provenance.untouchedPaths.length;
  const touched = declared > 0 ? ` Touched ${provenance.touchedPaths.length} of ${declared} declared file${declared === 1 ? "" : "s"}.` : "";
  return `Grounded in ${provenance.turnsUsed} of ${provenance.totalTurns} turns from session ${provenance.sessionId.slice(0, 8)}.${touched}`;
}
