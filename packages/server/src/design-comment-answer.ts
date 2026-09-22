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

import type { DesignStatement, DesignComment, DesignCommentReply } from "@twing/core";
import { callLlmMessages, type ChatMessage } from "./llm-client.js";
import { MAX_CONTEXT_CHARS, SYSTEM_PROMPT_RESERVE } from "./design-context.js";

const MAX_ATTEMPTS = 2;

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

You are given the design (its summary, the specific changes it declares, and the files it says it will create, modify and depend on). You may also be given an abridged, redacted transcript of the session that produced it -- what the developer and the agent actually said while the design was being made. Use it: it is what lets you answer "why" rather than only "what".

Three things about that transcript, when it is present:
- It is ABRIDGED. Where it says turns were elided, they were. Do not assume the parts you cannot see agree with you.
- It is REDACTED. A "[redacted]" span was a credential. Never speculate about what it contained.
- It is the session's own words, not a decision record. If the transcript shows the author wondering aloud and the design says something different, the design is what they committed to.

If no transcript is available, say so when it matters rather than guessing at intent.

Answer the reviewer directly and concretely, in plain prose. Two or three short paragraphs at most. Do not restate the design back at them -- they are looking at it. Never quote the transcript verbatim at length; it is a private conversation you are summarising from, not a document to republish.

When a conversation has already happened, answer the question they are asking NOW. Do not re-answer an earlier one, and do not repeat an answer already given above.

Then judge honestly whether a human developer needs to be pulled in. Set needsEscalation to true when ANY of these hold:
- The question asks about intent, priorities, or a tradeoff that neither the design nor the transcript settles. You cannot invent what the author meant.
- The reviewer is asking for a change to the design, not asking a question about it. Agreeing to a change is not yours to do.
- Answering would require knowledge of the wider codebase, the team's conventions, or history you were not given.
- The comment reports a problem that, if the reviewer is right, means the design is wrong.

Set needsEscalation to false only when what you were given genuinely contains the answer and you have just given it.

Do not pad an answer to avoid escalating. "The design does not say, and I would be guessing" is a better answer than a confident one that is invented. Prefer escalating when you are unsure.

Respond with ONLY a JSON object, no prose outside it and no markdown fence:
{"answer": string, "needsEscalation": boolean, "escalationReason": string, "confidence": "high" | "low"}

escalationReason must be one short sentence naming what specifically a human is needed for; use "" when needsEscalation is false.`;

/**
 * Everything the model is shown: the design, the session that produced it,
 * the conversation so far, and the question being asked now.
 *
 * The design-and-session half lives in `design-context.ts` (phase 2,
 * 2026-09) rather than here, because the reviewer chat needs exactly the same
 * grounding and neither surface should assemble its own. This function is
 * what remains: the comment thread, and which turn is the live question.
 *
 * `grounding` is passed in rather than read here so this stays a pure
 * function -- the route owns the capture store, and a test can build a
 * context without a filesystem. An empty string is legitimate and means
 * "design only"; `assembleDesignContext` never returns nothing.
 */
export function buildCommentAnswerContext(grounding: string, comment: DesignComment, replies: DesignCommentReply[], design?: DesignStatement): string {
  const sections: string[] = grounding.length > 0 ? [grounding] : [];

  // Resolved best-effort: an amendment can drop the change this comment was
  // anchored to. Losing the anchor must not lose the question, so the comment
  // is still shown -- just without the "they are asking about this specific
  // line" framing.
  if (comment.targetChangeId && design) {
    const anchor = design.changes?.find((c) => c.id === comment.targetChangeId);
    if (anchor) {
      const from = anchor.from ? ` (from ${anchor.from})` : "";
      sections.push(`THE REVIEWER IS ASKING ABOUT THIS SPECIFIC CHANGE:\n- ${anchor.action} ${anchor.target}${from}: ${anchor.intent}`);
    }
  }

  // The question to answer is the *latest* human turn, not necessarily the
  // one that opened the thread. A reviewer who reads an answer and asks
  // "why?" underneath is asking that, and pointing the model at the original
  // comment would have it re-answer something it has already answered while
  // the live question sat buried in the transcript.
  const history = [{ authorKind: "human" as const, message: comment.body }, ...replies];
  let liveIndex = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].authorKind === "human") {
      liveIndex = i;
      break;
    }
  }
  const live = liveIndex >= 0 ? history[liveIndex] : history[0];
  // The live question is *removed* from the transcript, not truncated at --
  // anything posted after it (an agent reply that landed via the CLI, say) is
  // still context the model needs.
  const transcript = history.filter((_, i) => i !== liveIndex);

  const liveSection = `THE REVIEWER IS NOW ASKING:\n${truncate(live.message, MAX_LIVE_QUESTION_CHARS)}`;
  const spent = sections.reduce((n, section) => n + section.length + 2, 0) + liveSection.length;

  if (transcript.length > 0) {
    // Budgeted against the room left *after* the system prompt, not against
    // MAX_CONTEXT_CHARS. Otherwise the parts sum to the budget, the system
    // prompt pushes the request over, and `capPrompt` trims the tail -- which
    // is where the live question sits. The question is the one thing that
    // must never be what gets cut.
    const room = MAX_CONTEXT_CHARS - SYSTEM_PROMPT.length - spent;
    const rendered = renderThread(transcript, Math.max(0, Math.min(MAX_THREAD_CHARS, room)));
    if (rendered) sections.push(`COMMENT THREAD SO FAR:\n${rendered}`);
  }

  return fitPrompt(sections.join("\n\n"), liveSection, SYSTEM_PROMPT);
}

/**
 * Last guard on the assembled prompt: fits it to the budget **around** the
 * live question, which is never what gets cut.
 *
 * This takes the question as its own argument rather than as the last of a
 * list of sections, and that signature is the fix. Three separate budgeting
 * bugs have now had the identical symptom -- the question sits last in the
 * prompt, every trim cuts from the end, so the one thing the model must see
 * is the first thing to go. Each was fixed by correcting arithmetic
 * upstream, and each time a *different* unreserved section reintroduced it:
 * the system prompt, then the thread, then a comment's anchored change.
 *
 * So the guarantee moved out of the arithmetic and into the shape. Context
 * is trimmed to whatever room the question leaves, the cut is marked where
 * it happens, and an unreserved section anywhere upstream now costs context
 * rather than the question. Getting the reserves right is still worth doing
 * -- it decides how much grounding survives -- but it is no longer what
 * stands between a reviewer and an answer to the question they asked.
 *
 * Takes the system prompt's length too, because the budget covers the
 * *request*: capping only the user half and then prepending a 2k system
 * prompt put the total back over by exactly that much.
 */
function fitPrompt(context: string, liveSection: string, systemPrompt: string): string {
  const room = MAX_CONTEXT_CHARS - systemPrompt.length - liveSection.length - 4;
  if (context.length <= room) return [context, liveSection].filter((s) => s.length > 0).join("\n\n");
  // No room for context at all -- the question alone is over budget, which
  // its own cap makes unreachable in practice. Send the question: an answer
  // to the right question with no context beats a well-grounded answer to
  // nothing.
  if (room <= CONTEXT_CUT_MARKER.length + 2) return liveSection;
  return `${context.slice(0, room - CONTEXT_CUT_MARKER.length - 2)}\n${CONTEXT_CUT_MARKER}\n\n${liveSection}`;
}

const CONTEXT_CUT_MARKER = "[… earlier context truncated to fit …]";

/** Per-turn cap inside the comment thread. Keeps one pasted stack trace from
 * consuming the budget and eliding the rest of the discussion. */
const MAX_THREAD_MESSAGE_CHARS = 2_000;

/**
 * How much of `MAX_CONTEXT_CHARS` a caller must leave for everything that is
 * *not* grounding: the system prompt, the thread so far, and the live
 * question.
 *
 * Grounding used to take the whole budget and these were added on top, so
 * the number every part respected individually was one the total never
 * did -- measured at 96,057 characters for a chat against a stated 48,000.
 * Now the answerer works out what it needs, the caller asks
 * `assembleDesignContext` for the remainder, and one budget covers the
 * prompt.
 */
export function groundingBudgetFor(question: string, historyChars: number): number {
  const reserve = SYSTEM_PROMPT_RESERVE + Math.min(question.length, MAX_LIVE_QUESTION_CHARS) + Math.min(historyChars, MAX_THREAD_CHARS);
  return Math.max(MIN_GROUNDING_CHARS, MAX_CONTEXT_CHARS - reserve);
}

/** Ceiling on the thread/history portion, so a long discussion cannot crowd
 * out the design it is about. */
const MAX_THREAD_CHARS = 12_000;

/** Floor on grounding, so a pathological question plus history cannot leave
 * the model with no design at all -- an answer with no idea what is being
 * reviewed is worse than a thinner one. The caps above make this
 * unreachable in practice; it is a guard against a future one being
 * raised. */
const MIN_GROUNDING_CHARS = 8_000;

/** The live question's own cap -- far larger than a thread turn, because this
 * is the thing being answered and truncating it is the one loss that makes
 * the answer wrong rather than merely thinner. Still capped: a reviewer can
 * paste a log as their question. */
const MAX_LIVE_QUESTION_CHARS = 8_000;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[… truncated …]` : text;
}

/**
 * The comment thread, fitted to whatever budget is left after the grounding
 * and the live question have taken theirs.
 *
 * **Head and tail, with the elision said out loud.** The opening turns carry
 * what the reviewer originally wanted and the closing ones carry where the
 * discussion got to; the middle of a long thread is the most expendable part
 * of it. Silent truncation is worse than either -- a model that cannot see
 * that a conversation was cut will answer as though it has the whole thing.
 */
function renderThread(transcript: { authorKind: "human" | "agent"; message: string }[], budget: number): string {
  const rendered = transcript.map((r) => `${r.authorKind === "agent" ? "AGENT" : "REVIEWER"}: ${truncate(r.message, MAX_THREAD_MESSAGE_CHARS)}`);
  const total = rendered.reduce((n, line) => n + line.length + 2, 0);
  if (total <= budget) return rendered.join("\n\n");

  const head: string[] = [];
  const tail: string[] = [];
  let used = 0;
  let i = 0;
  let j = rendered.length - 1;
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
  grounding: string,
  design: DesignStatement,
  comment: DesignComment,
  replies: DesignCommentReply[],
  options: CommentAnswerOptions,
): Promise<CommentAnswerResult> {
  const messages = buildMessages(buildCommentAnswerContext(grounding, comment, replies, design));

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

/**
 * A reviewer's chat turn (design review phase 2, 2026-09).
 *
 * Deliberately a different call from `answerDesignComment` despite sharing
 * this file and its grounding, because the two are answering different
 * things. A comment answer is a *verdict* with a structured escalation
 * recommendation attached, posted where a project reads it. A chat answer is
 * one side of a conversation with one person who is trying to understand a
 * design: it is prose, it has no escalation field, and it should feel like
 * talking to whoever wrote the thing.
 *
 * Fails soft to a sentence saying so, not to silence and not to an
 * exception: the reviewer is sitting at a prompt waiting, and "the model
 * could not be reached" is a usable answer where a spinner that never
 * resolves is not.
 */
export async function answerDesignChat(
  grounding: string,
  history: { role: "reviewer" | "agent"; message: string }[],
  options: CommentAnswerOptions,
): Promise<string> {
  const turns = history.slice(-MAX_CHAT_HISTORY_TURNS);
  const rendered = renderThread(
    turns.slice(0, -1).map((t) => ({ authorKind: t.role === "agent" ? ("agent" as const) : ("human" as const), message: t.message })),
    MAX_THREAD_CHARS,
  );
  const live = turns.length > 0 ? turns[turns.length - 1].message : "";

  const sections = [grounding];
  if (rendered.length > 0) sections.push(`CONVERSATION SO FAR:\n${rendered}`);
  const liveSection = `THE REVIEWER IS NOW ASKING:\n${truncate(live, MAX_LIVE_QUESTION_CHARS)}`;

  const messages: ChatMessage[] = [
    { role: "system", content: CHAT_SYSTEM_PROMPT },
    { role: "user", content: fitPrompt(sections.join("\n\n"), liveSection, CHAT_SYSTEM_PROMPT) },
  ];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const text = await callLlmMessages(messages, { model: options.model, region: options.region });
      const trimmed = text.trim();
      if (trimmed.length > 0) return trimmed;
      console.warn(`twing serve: design chat returned an empty answer (attempt ${attempt}/${MAX_ATTEMPTS})`);
    } catch (err) {
      console.warn(`twing serve: design chat call failed (attempt ${attempt}/${MAX_ATTEMPTS}): ${err instanceof Error ? err.message : err}`);
    }
  }
  return "twing could not reach a model to answer this. Nothing is wrong with your question — try again, or leave it as a comment so the developer sees it.";
}

/** How much of a chat is replayed to the model. A reviewer working through a
 * design asks a handful of questions, not a hundred; this is a bound against
 * a thread nobody closes rather than an expected shape. The budget in
 * `buildCommentAnswerContext` is per-character and this is per-turn because
 * they fail differently: a comment thread grows by pasted logs, a chat by
 * accumulating turns. */
const MAX_CHAT_HISTORY_TURNS = 20;

const CHAT_SYSTEM_PROMPT = `You are standing in for an AI coding agent, answering a reviewer's questions about a design it registered before writing any code.

You are given the design and, when the repository opted into session capture, an abridged and redacted transcript of the session that produced it. Use the transcript: it is what lets you answer "why" rather than only "what".

Three things about that transcript, when it is present:
- It is ABRIDGED. Where it says turns were elided, they were. Do not assume the parts you cannot see agree with you.
- It is REDACTED. A "[redacted]" span was a credential. Never speculate about what it contained.
- It is the session's own words, not a decision record. If it shows the author wondering aloud and the design says something different, the design is what they committed to.

This is a conversation, so write like one: plain prose, short, no headings, no bullet lists unless the answer genuinely is a list. Answer the question that was actually asked.

Never quote the transcript verbatim at length. You are summarising from a colleague's private working session, not republishing it.

Say plainly when you do not know. "The design does not say, and the session does not either — that is worth asking the author" is a good answer and a useful one; an invented rationale is worse than an admission, because the reviewer cannot tell the difference. If the reviewer seems to want a change rather than an explanation, tell them to leave it as a comment, which is the surface that reaches the developer.`;
