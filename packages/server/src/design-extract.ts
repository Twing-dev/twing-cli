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
}

const EMPTY_EXTRACTION: ExtractedDesign = { creates: [], touches: [], dependsOn: [], summary: "" };

const SYSTEM_PROMPT = [
  "Given an implementation plan, extract:",
  "1. new modules, classes, functions, or interfaces it creates",
  "2. existing files/modules it will modify",
  "3. existing modules/services/interfaces it depends on or calls into",
  "4. a one-paragraph summary",
  "",
  'Return JSON only, matching exactly this shape: {"creates": string[], "touches": string[], "dependsOn": string[], "summary": string}.',
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
  return { creates: obj.creates, touches: obj.touches, dependsOn: obj.dependsOn, summary: obj.summary };
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
