/**
 * Async, display-only re-classification of a declared change's `kind`.
 *
 * `inferKind` (design-changes.ts) guesses a kind from the file path with a
 * list of regexes. That guess is instant, free and offline -- and wrong in
 * ways no regex can fix, because a path means different things in different
 * ecosystems:
 *
 *   - `src/routes/WorkView.tsx` is a React *page component*, but `routes/`
 *     means backend HTTP handlers in Express/Hono, so it was tagged `api`.
 *     Found live in twing-monitor (2026-09).
 *   - A schema change usually lands in an ORM model or a service class
 *     (`models.py`, a JPA entity, a Drizzle `schema.ts`) rather than a
 *     `.sql` file, so the schema rules miss it and it falls through to
 *     `code` with nobody even seeing a wrong guess.
 *
 * Adding more folder names (`controller/`, `service/`) only moves the
 * collision somewhere else. The structurally correct answer -- "an exported
 * symbol referenced from outside its module boundary" -- needs a parser per
 * language (japicmp for Java, `apidiff` for Go, api-extractor for TS; there
 * is no universal one). A model reading the author's *stated intent* needs
 * no per-language work at all and generalizes to any ecosystem, which is
 * why this asks about intent rather than about the path.
 *
 * **It classifies from declared text, never from source.** The coordinator
 * is remote and never receives file contents -- only paths and the prose the
 * author wrote. That is a smaller input than a diff, and a sufficient one:
 * "Let the top bar search box grow to fill the space next to the repo name"
 * is obviously not an API change, whatever folder it lives in.
 *
 * Same fail-soft contract as `design-extract.ts` and
 * `design-semantic-check.ts`: one retry, then any error or unparseable
 * response returns `{}` -- "change nothing" -- rather than throwing. This
 * runs fire-and-forget after the triggering request already responded
 * (app.ts), and the fallback is the path guess that is live today, so a
 * failure here is never worse than not having this module at all. Nothing
 * downstream reads `kind` for a gate decision; it groups the dashboard's
 * "Design change" tab, and a wrong label costs a reader one glance.
 */

import { DESIGN_CHANGE_KINDS, type DesignChange, type DesignChangeKind, type DesignStatement } from "@twing/core";
import { callLlm } from "./llm-client.js";

const MAX_ATTEMPTS = 2;

/** Nothing to change -- what every failure path returns. */
const EMPTY_RESULT: Record<string, DesignChangeKind> = {};

/** Long intents are summaries of a summary already; the first sentence or
 * two carries the signal this needs, and a runaway `intent` shouldn't be
 * able to crowd the other changes out of one batched prompt. */
const MAX_INTENT_CHARS = 400;

export interface KindClassifyOptions {
  model: string;
  /** Bedrock only -- see `LlmCallOptions`. */
  region?: string;
}

/** Spelled out inline rather than interpolated from core's
 * `DESIGN_CHANGE_KINDS`, matching `design-extract.ts`'s convention: the
 * model needs each name's *meaning*, and a bare enum list carries none of
 * it. `isValidKind` below is what actually holds the two in sync -- a kind
 * this prompt invents but core doesn't know is dropped, not stored. */
const SYSTEM_PROMPT = [
  "You label declared code changes by which part of a system they touch.",
  "",
  "Label each change with exactly one of:",
  '  "api"    - a contract other code or other teams depend on: an HTTP route/endpoint, a public exported signature, an RPC/GraphQL surface, a published client library method.',
  '  "schema" - the shape of stored data: a migration, a table/column, an ORM model or entity class, an index. This is about persisted structure, NOT about which file extension it lives in.',
  '  "test"   - a test, spec, fixture or test helper.',
  '  "docs"   - documentation, README, changelog, comments-only prose.',
  '  "config" - build, deploy, CI, dependency manifests, environment or feature-flag settings.',
  '  "code"   - ordinary internal implementation, including UI/view/page components. This is the default: use it whenever the change is not clearly one of the five above.',
  "",
  "Rules:",
  "1. Judge primarily by the stated intent. The file path is a weak hint and is often misleading -- a folder called routes/ holds page components in some frameworks and HTTP handlers in others.",
  '2. "api" means an outside caller depends on it. A change to an internal function nobody outside the module calls is "code", even if it lives in a folder named api/ or controllers/.',
  '3. A UI, layout, styling, or page-component change is "code", never "api".',
  '4. When genuinely unsure, answer "code". Do not guess "api" or "schema" to seem precise.',
  "",
  'Reply with JSON only: an object mapping each given change id to its label, e.g. {"c1":"code","c2":"schema"}.',
  "Include every id you were given, and no others. No prose outside the JSON, no markdown code fences.",
].join("\n");

function userTurn(design: DesignStatement, changes: DesignChange[]): string {
  const lines = changes.map((c) => {
    const intent = c.intent.length > MAX_INTENT_CHARS ? `${c.intent.slice(0, MAX_INTENT_CHARS)}…` : c.intent;
    return `${c.id} | ${c.action} | ${c.target} | ${intent}`;
  });
  return [
    `Design goal: ${design.summary}`,
    "",
    "Changes (id | action | target | intent):",
    ...lines,
    "",
    "JSON:",
  ].join("\n");
}

function isValidKind(v: unknown): v is DesignChangeKind {
  return typeof v === "string" && (DESIGN_CHANGE_KINDS as readonly string[]).includes(v);
}

/**
 * Keeps only entries that name a requested id *and* a kind core recognizes.
 *
 * Drops rather than coerces, on both counts. A model that answers for an id
 * nobody asked about, or invents a seventh kind, is a model whose output for
 * that row can't be trusted -- and silently rewriting it to `"code"` would
 * bury a real prompt/schema drift under a plausible-looking label. An
 * unrecognized row simply keeps the path guess it already had.
 */
function parseResult(text: string, requestedIds: Set<string>): Record<string, DesignChangeKind> | undefined {
  let jsonText = text.trim();
  const fenced = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) jsonText = fenced[1].trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;

  const out: Record<string, DesignChangeKind> = {};
  for (const [id, kind] of Object.entries(parsed as Record<string, unknown>)) {
    if (!requestedIds.has(id)) continue;
    if (!isValidKind(kind)) continue;
    out[id] = kind;
  }
  return out;
}

/**
 * The kind each named change should carry, judged from its stated intent.
 *
 * `changeIds` is the subset whose kind was path-inferred rather than
 * author-declared (`pathInferredChangeIds`, design-changes.ts) -- an
 * explicitly written `kind:` is the author's word and this must never
 * overturn it.
 *
 * One batched call per design rather than one per change: the model reads
 * the design's goal once and sees its changes as a set, which is both
 * cheaper and better-informed than judging each path in isolation.
 *
 * The returned map is a *delta to apply*, not a complete answer -- ids the
 * model omitted, answered unrecognizably, or wasn't asked about are simply
 * absent, and an absent id keeps the kind it already has.
 */
export async function classifyChangeKinds(
  design: DesignStatement,
  changeIds: string[],
  options: KindClassifyOptions,
): Promise<Record<string, DesignChangeKind>> {
  const requestedIds = new Set(changeIds);
  const changes = (design.changes ?? []).filter((c) => requestedIds.has(c.id));
  if (changes.length === 0) return EMPTY_RESULT;

  const prompt = userTurn(design, changes);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const text = await callLlm(SYSTEM_PROMPT, prompt, { model: options.model, region: options.region });
      const parsed = parseResult(text, requestedIds);
      if (parsed) return parsed;
      console.warn(`twing serve: change-kind classification returned malformed JSON (attempt ${attempt}/${MAX_ATTEMPTS})`);
    } catch (err) {
      console.warn(`twing serve: change-kind classification call failed (attempt ${attempt}/${MAX_ATTEMPTS}): ${err instanceof Error ? err.message : err}`);
    }
  }
  return EMPTY_RESULT;
}
