/**
 * The model behind a reviewer's private "Ask this design" chat (design review
 * phase 2, 2026-09).
 *
 * This file also used to hold the coordinator's first-pass answer to every
 * public review comment. That was removed on 2026-09-27: the coordinator holds
 * designs, not code, so it was answering questions about a codebase it had
 * never seen, and review comments are now answered by people only (see
 * `design-comment-store.ts`). The chat stays -- it is explicitly a reviewer
 * thinking out loud against the design and the session that produced it, not
 * an answer anyone else relies on. The file keeps its name so the chat's
 * callers did not have to move with it.
 *
 * Structurally this is `design-semantic-check.ts`: `callLlmMessages`, two
 * attempts, and no throwing.
 */

import { callLlmMessages, type ChatMessage } from "./llm-client.js";
import { MAX_CONTEXT_CHARS, SYSTEM_PROMPT_RESERVE } from "./design-context.js";

const MAX_ATTEMPTS = 2;

/**
 * Last guard on the assembled prompt: fits it to the budget **around** the
 * live question, which is never what gets cut.
 *
 * This takes the question as its own argument rather than as the last of a
 * list of sections, and that signature is the fix. Three separate budgeting
 * bugs have now had the identical symptom -- the question sits last in the
 * prompt, every trim cuts from the end, so the one thing the model must see
 * is the first thing to go. Each was fixed by correcting arithmetic
 * upstream, and each time a *different* unreserved section reintroduced it.
 *
 * So the guarantee moved out of the arithmetic and into the shape. Context
 * is trimmed to whatever room the question leaves, the cut is marked where
 * it happens, and an unreserved section anywhere upstream now costs context
 * rather than the question.
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

/** Per-turn cap inside the conversation. Keeps one pasted stack trace from
 * consuming the budget and eliding the rest of the discussion. */
const MAX_THREAD_MESSAGE_CHARS = 2_000;

/**
 * How much of `MAX_CONTEXT_CHARS` a caller must leave for everything that is
 * *not* grounding: the system prompt, the conversation so far, and the live
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

/** Ceiling on the history portion, so a long conversation cannot crowd out
 * the design it is about. */
const MAX_THREAD_CHARS = 12_000;

/** Floor on grounding, so a pathological question plus history cannot leave
 * the model with no design at all -- an answer with no idea what is being
 * reviewed is worse than a thinner one. The caps above make this
 * unreachable in practice; it is a guard against a future one being
 * raised. */
const MIN_GROUNDING_CHARS = 8_000;

/** The live question's own cap -- far larger than a history turn, because this
 * is the thing being answered and truncating it is the one loss that makes
 * the answer wrong rather than merely thinner. Still capped: a reviewer can
 * paste a log as their question. */
const MAX_LIVE_QUESTION_CHARS = 8_000;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[… truncated …]` : text;
}

/**
 * The conversation so far, fitted to whatever budget is left after the
 * grounding and the live question have taken theirs.
 *
 * **Head and tail, with the elision said out loud.** The opening turns carry
 * what the reviewer originally wanted and the closing ones carry where the
 * discussion got to; the middle of a long thread is the most expendable part
 * of it. Silent truncation is worse than either -- a model that cannot see
 * that a conversation was cut will answer as though it has the whole thing.
 */
function renderThread(transcript: { role: "reviewer" | "agent"; message: string }[], budget: number): string {
  const rendered = transcript.map((r) => `${r.role === "agent" ? "AGENT" : "REVIEWER"}: ${truncate(r.message, MAX_THREAD_MESSAGE_CHARS)}`);
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

export interface CommentAnswerOptions {
  model: string;
  /** Bedrock only -- see `LlmCallOptions.region`. */
  region?: string;
}

/**
 * A reviewer's chat turn.
 *
 * Prose, with no structured fields: it is one side of a conversation with one
 * person who is trying to understand a design, and it should feel like
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
  const rendered = renderThread(turns.slice(0, -1), MAX_THREAD_CHARS);
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
 * a thread nobody closes rather than an expected shape. */
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
