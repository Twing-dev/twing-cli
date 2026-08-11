/**
 * `rawPlanText` -> structured design fields, via one OpenRouter chat-
 * completion call (design doc §17.3). Same call shape as
 * `simulator/src/drivers/openrouter-driver.ts`, duplicated rather than
 * imported -- the server package shouldn't depend on the simulator.
 *
 * Fails soft: any error, or malformed JSON surviving one retry, returns
 * empty fields rather than throwing. Degrading a blocking gate to "no
 * check ran" is the right failure mode; "deny everyone" is not.
 */

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
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

async function callOnce(planText: string, model: string, apiKey: string): Promise<string> {
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: planText.slice(0, MAX_PLAN_CHARS) },
      ],
    }),
  });

  const body = (await res.json()) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } };
  if (!res.ok) {
    throw new Error(`OpenRouter request failed (${res.status}): ${body.error?.message ?? JSON.stringify(body)}`);
  }
  return body.choices?.[0]?.message?.content?.trim() ?? "";
}

export interface ExtractOptions {
  model: string;
  apiKey?: string;
}

export async function extractDesign(planText: string, options: ExtractOptions): Promise<ExtractedDesign> {
  if (!options.apiKey) {
    console.warn("twing serve: no OPENROUTER_API_KEY set -- design extraction skipped, treating plan as clean");
    return EMPTY_EXTRACTION;
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const text = await callOnce(planText, options.model, options.apiKey);
      const parsed = parseExtraction(text);
      if (parsed) return parsed;
      console.warn(`twing serve: design extraction returned malformed JSON (attempt ${attempt}/${MAX_ATTEMPTS})`);
    } catch (err) {
      console.warn(`twing serve: design extraction call failed (attempt ${attempt}/${MAX_ATTEMPTS}): ${err instanceof Error ? err.message : err}`);
    }
  }
  return EMPTY_EXTRACTION;
}
