/**
 * `rawPlanText` -> structured design fields, via one LLM chat-completion
 * call to Bedrock (design doc §17.3, statefulness/eval work 2026-08; see
 * `llm-client.ts`'s header comment for why that's bedrock-mantle rather
 * than the standard Bedrock Runtime API). Same prompt/parsing shape as
 * `simulator/src/drivers/bedrock-driver.ts`, duplicated rather than
 * imported -- the server package shouldn't depend on the simulator.
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

// Item 5 is what makes plan mode produce the same structured declaration a
// hand-written `--from` template does. Kept in the *same* call rather than
// a second one: the model has already read the plan, a second pass would
// double the latency of a path that blocks an agent mid-`ExitPlanMode`,
// and two calls can disagree about scope in a way one cannot.
//
// The enums are spelled out inline instead of being interpolated from
// core's DESIGN_CHANGE_ACTIONS/KINDS. Deliberate: the prompt also has to
// explain *when* each value applies, so interpolating the list alone
// would keep only half of it in sync and quietly imply the other half
// tracked too. core's `validateTemplate`/`ensureChanges` reject anything
// off-list, so a drifted prompt degrades to a derived change rather than
// admitting an invalid one.
const SYSTEM_PROMPT = [
  "Given an implementation plan, extract:",
  "1. new modules, classes, functions, or interfaces it creates",
  "2. existing files/modules it will modify",
  "3. existing modules/services/interfaces it depends on or calls into",
  "4. a one-paragraph summary",
  "5. one structured item per concrete change the plan describes",
  "",
  "Each item in `changes` is an object:",
  '  id     -- short unique slug, e.g. "c1", "c2"',
  "  action -- exactly one of: add, modify, rewrite, remove, rename, move",
  "  kind   -- exactly one of: code, api, schema, test, docs, config",
  "  target -- the file path, or path::Symbol.method when the plan names a specific symbol",
  "  intent -- one sentence on what this change achieves, in the plan's own terms",
  '  from   -- REQUIRED for rename/move (the previous name or path), omitted otherwise',
  "",
  "Every path in `creates` or `touches` should appear as the target of exactly one item.",
  "Use `add` for anything in `creates`. Do not invent changes the plan does not describe.",
  "",
  'Return JSON only, matching exactly this shape: {"creates": string[], "touches": string[], "dependsOn": string[], "summary": string, "changes": object[]}.',
  'If a field is empty, return [] or "". No prose, no markdown code fences -- JSON only.',
].join("\n");

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
  return callLlm(SYSTEM_PROMPT, planText.slice(0, MAX_PLAN_CHARS), { model: options.model, region: options.region });
}

export interface ExtractOptions {
  model: string;
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
