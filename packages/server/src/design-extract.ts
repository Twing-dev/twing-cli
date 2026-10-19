/**
 * `rawPlanText` -> structured design fields, via one LLM chat-completion
 * call to Bedrock (design doc §17.3, statefulness/eval work 2026-08; see
 * `llm-client.ts`'s header comment for why that's bedrock-mantle rather
 * than the standard Bedrock Runtime API).
 *
 * Fails soft: any error, or malformed JSON surviving one retry, returns
 * empty fields rather than throwing. Degrading a blocking gate to "no
 * check ran" is the right failure mode; "deny everyone" is not. Unlike the
 * old OpenRouter path (removed 2026-08-17), there's no upfront
 * credential-presence check to skip on -- Bedrock's `AWS_BEARER_TOKEN_BEDROCK`
 * is read ambiently by `llm-client.ts`, so a misconfigured server finds out
 * the same way any other failure does: the real call throws, retries once,
 * then falls soft. See main.ts's startup check for the one place this is
 * still flagged proactively (a log line, not a precheck here).
 */

import { callLlm } from "./llm-client.js";
// Moved to llm-prompts.ts (2026-10-10), alongside every other prompt this
// server sends, so they can be read in one place -- see that file's header.
import { DESIGN_EXTRACT_PROMPT as SYSTEM_PROMPT } from "./llm-prompts.js";

const MAX_ATTEMPTS = 2;
const MAX_PLAN_CHARS = 8000;

export interface ExtractedDesign {
  creates: string[];
  touches: string[];
  dependsOn: string[];
  summary: string;
  /** Structured per-item declaration (2026-09-15). Optional on this type,
   * not on a registered design: a model can return a malformed or empty
   * list and this module fails soft over it, but `ensureChanges`
   * (design-changes.ts) then derives from `creates`/`touches` so the
   * design still ends up with one. Never trusted as-is -- that function
   * re-validates every item, since this is model output. */
  changes?: unknown;
}

const EMPTY_EXTRACTION: ExtractedDesign = { creates: [], touches: [], dependsOn: [], summary: "" };


function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function parseExtraction(text: string): ExtractedDesign | undefined {
  let jsonText = text.trim();
  const fenced = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) jsonText = fenced[1].trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;

  const obj = parsed as Record<string, unknown>;
  if (!isStringArray(obj.creates) || !isStringArray(obj.touches) || !isStringArray(obj.dependsOn) || typeof obj.summary !== "string") {
    return undefined;
  }
  // `changes` is carried through unvalidated and deliberately does *not*
  // participate in the checks above. A model that gets the four original
  // fields right but the new one wrong must still produce a usable
  // extraction -- the alternative is that adding item 5 to the prompt made
  // the whole ExitPlanMode path more likely to fail soft to "clean", which
  // would be a gate regression traded for a display feature.
  // `ensureChanges` is what validates it.
  //
  // Spread rather than assigned, so an extraction with no `changes` has no
  // such key at all instead of one holding `undefined` -- the same
  // absent-is-absent convention `parseDesignTemplate` follows for optional
  // fields, and what keeps this type's shape unchanged for every existing
  // caller and test.
  return {
    creates: obj.creates,
    touches: obj.touches,
    dependsOn: obj.dependsOn,
    summary: obj.summary,
    ...(obj.changes !== undefined ? { changes: obj.changes } : {}),
  };
}

async function callOnce(planText: string, options: ExtractOptions): Promise<string> {
  return callLlm(SYSTEM_PROMPT, planText.slice(0, MAX_PLAN_CHARS), {
    model: options.model,
    region: options.region,
    tag: { purpose: "design_extract", ...options.context },
  });
}

export interface ExtractOptions {
  model: string;
  /** Log-only ids (daily-log.ts). The design doesn't exist yet when this
   * runs, so the session/project is all there is to tag it with. */
  context?: { sessionId?: string; projectId?: string };
  /** Omit to fall back to AWS_REGION/AWS_DEFAULT_REGION (llm-client.ts's
   * ambient resolution). */
  region?: string;
}

export async function extractDesign(planText: string, options: ExtractOptions): Promise<ExtractedDesign> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const text = await callOnce(planText, options);
      const parsed = parseExtraction(text);
      if (parsed) return parsed;
      console.warn(`twing serve: design extraction returned malformed JSON (attempt ${attempt}/${MAX_ATTEMPTS})`);
    } catch (err) {
      console.warn(`twing serve: design extraction call failed (attempt ${attempt}/${MAX_ATTEMPTS}): ${err instanceof Error ? err.message : err}`);
    }
  }
  return EMPTY_EXTRACTION;
}
