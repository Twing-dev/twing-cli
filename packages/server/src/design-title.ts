/**
 * The short heading twing-monitor shows for a design (2026-10-12).
 *
 * Before this, nothing ever wrote a heading. The monitor cut one out of
 * `summary` (`designTitle.ts` over there): the first sentence, clamped. That
 * was a sentence written as prose, not a heading, and once overview
 * resynthesis had rewritten the summary as `Problem: ... / Approach: ...`, the
 * first sentence was the *problem* -- so a list of designs read as a list of
 * complaints rather than a list of work.
 *
 * One short model call, stored in its own column (`generated_title`), never
 * in `title`: that one is the owner's, and the monitor shows it first.
 *
 * Runs in the background only -- after registration and after resynthesis
 * writes a new overview -- never on the gate's blocking path. Fails soft like
 * every other model call here: an outage leaves whatever heading the design
 * already had, and the monitor's own derivation still covers a design that
 * never got one.
 */

import type { DesignStatement } from "@twing/core";
import { DESIGN_TITLE_PROMPT } from "./llm-prompts.js";
import type { LlmTag } from "./llm-client.js";
import { planSectionFor } from "./overview-resynthesis.js";

/** A model that ignores "at most 8 words" and returns a paragraph has
 * returned something that isn't a heading; keeping the old one is better
 * than storing that. Generous on purpose -- this rejects prose, it doesn't
 * enforce the word count. */
export const MAX_GENERATED_TITLE_CHARS = 80;

/** Cap on the summary inside the prompt: a heading needs the gist, and a
 * summary with a long amendment pile can be thousands of characters. */
const MAX_SUMMARY_CHARS = 4_000;

export interface TitleDeps {
  getDesign: (id: string) => DesignStatement | undefined;
  callModel: (systemPrompt: string, userPrompt: string, tag: LlmTag) => Promise<string>;
  writeTitle: (id: string, title: string) => void;
  log?: (message: string) => void;
}

/** First line only, without the wrapping a model adds despite being told not
 * to: quotes, a `Title:` prefix, a trailing period. `undefined` when what is
 * left is empty or too long to be a heading. */
export function cleanTitle(raw: string): string | undefined {
  const line = raw.trim().split("\n")[0].trim();
  const text = line
    .replace(/^(title|heading)\s*:\s*/i, "")
    .replace(/^["'`*]+|["'`*]+$/g, "")
    .replace(/\.$/, "")
    .trim();
  if (text.length === 0 || text.length > MAX_GENERATED_TITLE_CHARS) return undefined;
  return text;
}

function buildUserPrompt(design: DesignStatement): string {
  const summary = design.summary.length > MAX_SUMMARY_CHARS ? `${design.summary.slice(0, MAX_SUMMARY_CHARS)}…` : design.summary;
  const parts = [`OVERVIEW:\n${summary}`];
  const plan = planSectionFor(design);
  if (plan) parts.push(`PLAN:\n${plan}`);
  return parts.join("\n\n");
}

/**
 * Asks for a heading and stores it.
 *
 * The summary is read before the call and again after: if it changed while
 * the model ran (an amend, a resynthesis, an owner edit), the heading
 * describes text that is gone and is dropped. Whatever changed the summary
 * schedules its own refresh, so nothing is lost by dropping it.
 */
export async function refreshGeneratedTitle(
  deps: TitleDeps,
  designId: string,
): Promise<"written" | "no_such_design" | "no_title" | "design_moved"> {
  const before = deps.getDesign(designId);
  if (!before) return "no_such_design";

  let title: string | undefined;
  try {
    const out = await deps.callModel(DESIGN_TITLE_PROMPT, buildUserPrompt(before), {
      purpose: "design_title",
      designId: before.id,
      groupId: before.groupId,
      sessionId: before.sessionId,
      projectId: before.projectId,
    });
    title = cleanTitle(out);
  } catch (err) {
    deps.log?.(`twing serve: design ${designId.slice(0, 8)} title failed -- keeping existing heading (${String(err)})`);
    return "no_title";
  }
  if (!title) return "no_title";

  const after = deps.getDesign(designId);
  if (!after) return "no_such_design";
  if (after.summary !== before.summary) return "design_moved";

  deps.writeTitle(designId, title);
  return "written";
}
