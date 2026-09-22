/**
 * The agent's first pass at a review comment (design review, 2026-09).
 *
 * When a reviewer asks a question about a registered design, a human
 * developer is the expensive way to answer it and usually not the necessary
 * one: most review comments are answerable from the design itself. So the
 * coordinator answers first, and a human is pulled in only when the reviewer
 * decides that answer wasn't good enough.
 *
 * Structurally this is `design-semantic-check.ts`: `callLlmMessages`, two
 * attempts, a strict JSON parse behind a type guard, and no throwing. One
 * thing is deliberately inverted, and it is the most important line in this
 * file:
 *
 *   **This fails soft toward escalation, not toward silence.**
 *
 * The comparator under-flags on failure because inventing a conflict between
 * two innocent designs is the worse error. Here the worse error runs the
 * other way. A comment that shows up with no answer and no escalation looks,
 * to the reviewer who wrote it and to the developer who owns the design,
 * exactly like a comment that was considered and found unremarkable -- so an
 * unreachable model would silently swallow review feedback. Escalating
 * instead costs one line in somebody's next session banner, which is
 * recoverable; a silently dropped question is not.
 *
 * `needsEscalation` is a **recommendation, never a decision**. Only a
 * reviewer moves a comment to `escalated` (`POST /v1/comments/:id/escalate`).
 * That split is deliberate: the model is the party least able to judge
 * whether its own answer satisfied the person who asked, and letting it
 * escalate on its own confidence would put it in charge of interrupting a
 * developer's session.
 *
 * Context assembly lives in `buildCommentAnswerContext` rather than inline,
 * so Phase 2's capture-grounded assembler (`design-context.ts`) can replace
 * what the model sees without touching the prompt, the parse or the retry
 * policy.
 */

import type { DesignStatement, DesignComment, DesignCommentReply, DesignChange } from "@twing/core";
import { callLlmMessages, type ChatMessage } from "./llm-client.js";

const MAX_ATTEMPTS = 2;

/** Bound on what one design contributes to the prompt. A design's summary is
 * normally a paragraph, but `rawPlanExcerpt` carries an entire `ExitPlanMode`
 * plan verbatim and has had its own truncation cap removed upstream
 * (see `DesignStatement.rawPlanExcerpt`), so it can be arbitrarily long.
 * Trimmed here rather than there: the plan text being complete is
 * load-bearing for the semantic comparator and the retry-dedup check, and
 * this is the only consumer that has a budget to keep. */
const MAX_PLAN_CHARS = 12_000;

/**
 * Total budget for everything sent to the model, in characters.
 *
 * Every individual field was capped before this and the *whole* was not,
 * which is a distinction that only bites once threads grow: a synthetic
 * 100-message discussion produced over a million characters of input (found
 * in review), and both attempts of the retry loop would have re-sent the
 * same oversized prompt. Pasted logs get there faster than long discussions.
 *
 * ~48k characters is roughly 12k tokens -- comfortable on every model in
 * `PROVIDER_MODELS` with room for the answer, and deliberately not tuned to
 * the largest of them: this task needs a design and a conversation, not a
 * codebase, and a budget that only fits on the biggest model is one that
 * breaks when an operator points `TWING_<PROVIDER>_COMMENT_ANSWER_MODEL` at
 * something cheaper.
 */
const MAX_CONTEXT_CHARS = 48_000;

/** Per-turn cap inside the transcript. Keeps one pasted stack trace from
 * consuming the whole budget and eliding the rest of the conversation. */
const MAX_TRANSCRIPT_MESSAGE_CHARS = 2_000;

/** The live question's own cap -- far larger than a transcript turn, because
 * this is the thing being answered and truncating it is the one loss that
 * makes the answer wrong rather than merely thinner. Still capped: a reviewer
 * can paste a log as their question. */
const MAX_LIVE_QUESTION_CHARS = 8_000;

/** Said out loud when the design's own declaration is too big to send whole.
 * Distinct wording from the transcript's per-turn `[… truncated …]` so a
 * reader can tell *what* was cut. */
const DESIGN_ELIDED_MARKER = "[… the rest of this design's declaration was too long to include …]";

export interface CommentAnswerResult {
  /** The answer, as the reviewer will read it. Empty only on the fail-soft
   * path, where `needsEscalation` is always true. */
  answer: string;
  /** The model's own read on whether this needs a human. A recommendation
   * shown to the reviewer, never an action -- see this file's header. */
  needsEscalation: boolean;
  /** Why, in one line. Empty when `needsEscalation` is false. */
  escalationReason: string;
  confidence: "high" | "low";
}

/** What a failed call returns. Note `needsEscalation: true` -- see the
 * header. The reason text is written to be read by a human in the UI, so it
 * says what actually happened rather than "error". */
const UNREACHABLE_RESULT: CommentAnswerResult = {
  answer: "",
  needsEscalation: true,
  escalationReason: "twing could not reach a model to answer this, so nobody has looked at it yet.",
  confidence: "low",
};

const SYSTEM_PROMPT = `You are answering a reviewer's question about a software design that an AI coding agent registered before writing any code. You are standing in for that agent.

You are given the design (its summary, the specific changes it declares, and the files it says it will create, modify and depend on), the reviewer's comment, and any replies already posted.

Answer the reviewer directly and concretely, in plain prose. Two or three short paragraphs at most. Do not restate the design back at them -- they are looking at it.

When a conversation has already happened, answer the question they are asking NOW. Do not re-answer an earlier one, and do not repeat an answer already given above.

Then judge honestly whether a human developer needs to be pulled in. Set needsEscalation to true when ANY of these hold:
- The question asks about intent, priorities, or a tradeoff the design does not state. You cannot invent what the author meant.
- The reviewer is asking for a change to the design, not asking a question about it. Agreeing to a change is not yours to do.
- Answering would require knowledge of the wider codebase, the team's conventions, or history that is not in the design.
- The comment reports a problem that, if the reviewer is right, means the design is wrong.

Set needsEscalation to false only when the design genuinely already contains the answer and you have just given it.

Do not pad an answer to avoid escalating. "The design does not say, and I would be guessing" is a better answer than a confident one that is invented. Prefer escalating when you are unsure.

Respond with ONLY a JSON object, no prose outside it and no markdown fence:
{"answer": string, "needsEscalation": boolean, "escalationReason": string, "confidence": "high" | "low"}

escalationReason must be one short sentence naming what specifically a human is needed for; use "" when needsEscalation is false.`;

function renderChange(change: DesignChange): string {
  const from = change.from ? ` (from ${change.from})` : "";
  const kind = change.kind && change.kind !== "code" ? ` [${change.kind}]` : "";
  return `- ${change.action}${kind} ${change.target}${from}: ${change.intent}`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[… truncated …]` : text;
}

/**
 * Everything the model is shown about the design and the conversation so far.
 *
 * Exported and separate from `buildMessages` for two reasons: Phase 2 swaps
 * this for the capture-grounded assembler, and a test can assert what a
 * reviewer's question is actually being answered against without stubbing a
 * model call.
 *
 * Structured `changes` supersede the flat `creates`/`touches` lists when
 * present rather than sitting alongside them -- the two are the same
 * information (`creates`/`touches` are *derived* from `changes`, see
 * `deriveScope` in core's design-scope.ts), and printing both would spend
 * budget saying everything twice.
 */
export function buildCommentAnswerContext(design: DesignStatement, comment: DesignComment, replies: DesignCommentReply[]): string {
  const sections: string[] = [`DESIGN SUMMARY:\n${design.summary}`];

  if (design.changes && design.changes.length > 0) {
    sections.push(`DECLARED CHANGES:\n${design.changes.map(renderChange).join("\n")}`);
  } else {
    if (design.creates.length > 0) sections.push(`CREATES: ${design.creates.join(", ")}`);
    if (design.touches.length > 0) sections.push(`TOUCHES: ${design.touches.join(", ")}`);
  }
  if (design.dependsOn.length > 0) sections.push(`DEPENDS ON: ${design.dependsOn.join(", ")}`);

  // Only for a design that has no structured changes -- for one that does,
  // the plan text is the same declaration again in prose form, and the
  // budget is better spent elsewhere.
  if (design.rawPlanExcerpt && !(design.changes && design.changes.length > 0)) {
    sections.push(`ORIGINAL PLAN TEXT:\n${truncate(design.rawPlanExcerpt, MAX_PLAN_CHARS)}`);
  }

  // Resolved best-effort: an amendment can drop the change this comment was
  // anchored to. Losing the anchor must not lose the question, so the comment
  // is still shown -- just without the "they are asking about this specific
  // line" framing.
  if (comment.targetChangeId) {
    const anchor = design.changes?.find((c) => c.id === comment.targetChangeId);
    if (anchor) sections.push(`THE REVIEWER IS ASKING ABOUT THIS SPECIFIC CHANGE:\n${renderChange(anchor)}`);
  }

  // The question to answer is the *latest* human turn, not necessarily the
  // one that opened the thread. A reviewer who reads an answer and asks
  // "why?" underneath is asking that, and putting the original comment last
  // would point the model at a question it has already answered while
  // burying the live one in the transcript.
  const history = [{ authorKind: "human" as const, message: comment.body }, ...replies];
  // The live question is *removed* from the transcript, not truncated at --
  // anything posted after it (an agent reply that landed via the CLI, say)
  // is still context the model needs, and cutting the tail off would hide
  // that the question has already been partly answered.
  let liveIndex = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].authorKind === "human") {
      liveIndex = i;
      break;
    }
  }
  const live = liveIndex >= 0 ? history[liveIndex] : history[0];
  const transcript = history.filter((_, i) => i !== liveIndex);

  // The live question is placed last but budgeted first: everything above is
  // context that can be thinned, and this is the thing being answered.
  const liveSection = `THE REVIEWER IS NOW ASKING:\n${truncate(live.message, MAX_LIVE_QUESTION_CHARS)}`;
  const spent = sections.reduce((n, section) => n + section.length + 2, 0) + liveSection.length;

  if (transcript.length > 0) {
    const rendered = renderTranscript(transcript, Math.max(0, MAX_CONTEXT_CHARS - spent));
    if (rendered) sections.push(`CONVERSATION SO FAR:\n${rendered}`);
  }

  sections.push(liveSection);
  const assembled = sections.join("\n\n");
  if (assembled.length <= MAX_CONTEXT_CHARS) return assembled;

  // Backstop for the one case the transcript budget above cannot cover: the
  // design's own fields exceeding the budget on their own, which a design
  // declaring hundreds of changes will do with no conversation at all. The
  // live question is re-appended whole afterwards rather than trimmed with
  // everything else -- losing the design's tail makes the answer thinner,
  // losing the question makes it answer the wrong thing.
  //
  // The marker's room is reserved *before* slicing. Slicing to the budget
  // and then asking `truncate` to cut at the same budget produced a string
  // of exactly that length, so its "was this too long?" test was false and
  // the marker was never added -- a 60k-character design silently became a
  // 48k-character context with nothing saying so (found in review). Silent
  // truncation is the failure this whole budget is written against; a cut
  // the model cannot see is one it will answer straight through.
  const room = Math.max(0, MAX_CONTEXT_CHARS - liveSection.length - DESIGN_ELIDED_MARKER.length - 4);
  return `${assembled.slice(0, room)}\n${DESIGN_ELIDED_MARKER}\n\n${liveSection}`;
}

/**
 * The conversation, fitted to whatever budget is left after the design and
 * the live question have taken theirs.
 *
 * **Head and tail, with the elision said out loud.** The opening turns carry
 * what the reviewer originally wanted and the closing ones carry where the
 * discussion actually got to; the middle of a long thread is the most
 * expendable part of it. Plain truncation from either end loses one of those
 * two, and silent truncation is worse than either -- a model that cannot see
 * that a conversation was cut will answer as though it has the whole thing.
 *
 * Returns an empty string when there is no room at all, which the caller
 * renders as no transcript section rather than an empty heading.
 */
function renderTranscript(transcript: { authorKind: "human" | "agent"; message: string }[], budget: number): string {
  const render = (r: { authorKind: "human" | "agent"; message: string }) =>
    `${r.authorKind === "agent" ? "AGENT" : "REVIEWER"}: ${truncate(r.message, MAX_TRANSCRIPT_MESSAGE_CHARS)}`;

  const rendered = transcript.map(render);
  const total = rendered.reduce((n, line) => n + line.length + 2, 0);
  if (total <= budget) return rendered.join("\n\n");

  const head: string[] = [];
  const tail: string[] = [];
  let used = 0;
  let i = 0;
  let j = rendered.length - 1;
  // Alternate from both ends so neither the original intent nor the current
  // state of the discussion is dropped wholesale, and stop as soon as the
  // next turn would not fit.
  while (i <= j) {
    const takeHead = head.length <= tail.length;
    const line = takeHead ? rendered[i] : rendered[j];
    // Leave room for the marker itself -- an elision nobody can see is the
    // silent truncation this exists to avoid.
    if (used + line.length + 2 > budget - 40) break;
    used += line.length + 2;
    if (takeHead) {
      head.push(line);
      i++;
    } else {
      tail.unshift(line);
      j--;
    }
  }

  const elided = j - i + 1;
  if (head.length === 0 && tail.length === 0) return "";
  if (elided <= 0) return [...head, ...tail].join("\n\n");
  return [...head, `[… ${elided} earlier message${elided === 1 ? "" : "s"} elided …]`, ...tail].join("\n\n");
}

/** The two fields a response is worthless without. `escalationReason` and
 * `confidence` are deliberately *not* checked here and are normalized in
 * `parseResult` instead: a model that answered the question well but omitted
 * a label should not have its answer thrown away over the label. */
interface RawAnswer extends Record<string, unknown> {
  answer: string;
  needsEscalation: boolean;
}

function isValidResult(v: unknown): v is RawAnswer {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  if (typeof obj.answer !== "string") return false;
  if (typeof obj.needsEscalation !== "boolean") return false;
  return true;
}

function parseResult(text: string): CommentAnswerResult | undefined {
  let jsonText = text.trim();
  const fenced = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) jsonText = fenced[1].trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return undefined;
  }
  if (!isValidResult(parsed)) return undefined;

  const answer = parsed.answer.trim();
  const reason = typeof parsed.escalationReason === "string" ? parsed.escalationReason.trim() : "";
  // An empty answer is a failed answer regardless of what the model claimed
  // about it -- fall back to escalation rather than posting a blank reply
  // that reads as "considered, nothing to say".
  const needsEscalation = parsed.needsEscalation || answer.length === 0;

  return {
    answer,
    needsEscalation,
    escalationReason: needsEscalation ? reason || "the agent could not answer this from the design alone." : "",
    confidence: parsed.confidence === "high" && !needsEscalation ? "high" : "low",
  };
}

function buildMessages(context: string): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: context },
  ];
}

export interface CommentAnswerOptions {
  model: string;
  /** Bedrock only -- see `LlmCallOptions.region`. */
  region?: string;
}

/**
 * Answers one comment, or says it couldn't.
 *
 * Never throws: the caller is a fire-and-forget background pass
 * (`runCommentAnswerPass` in app.ts) whose response has already been sent,
 * so a throw here has nowhere to go but an unhandled rejection.
 */
export async function answerDesignComment(
  design: DesignStatement,
  comment: DesignComment,
  replies: DesignCommentReply[],
  options: CommentAnswerOptions,
): Promise<CommentAnswerResult> {
  const messages = buildMessages(buildCommentAnswerContext(design, comment, replies));

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const text = await callLlmMessages(messages, { model: options.model, region: options.region });
      const parsed = parseResult(text);
      if (parsed) return parsed;
      console.warn(`twing serve: comment answer returned malformed JSON (attempt ${attempt}/${MAX_ATTEMPTS})`);
    } catch (err) {
      console.warn(`twing serve: comment answer call failed (attempt ${attempt}/${MAX_ATTEMPTS}): ${err instanceof Error ? err.message : err}`);
    }
  }
  return UNREACHABLE_RESULT;
}
