/**
 * Async, advisory-only semantic conflict comparator -- the "detailed path"
 * alongside `design-checks.ts`'s purely syntactic tiers (§17.4). Two designs
 * describing a real, non-obvious conflict in unrelated-sounding words sail
 * through `runDesignChecks` as `clean`: it only ever compares literal
 * `creates`/`touches`/`dependsOn` intersections and a Jaccard keyword
 * fallback on `summary`. This module asks an LLM the question those tiers
 * structurally can't: does one design's actual content conflict with
 * another's, judged on what each plan *does*, not on whether their file
 * lists happen to overlap.
 *
 * Prompt/few-shot shape here is the exact one validated empirically
 * (2026-08) against a 25-case labeled eval set (design-eval-cases.ts) plus 4
 * hand-authored full-scale plans with a deliberately hidden conflict: three
 * plain criteria, one explicit line countering the model's persistent
 * "different files/layers/components ⇒ not a conflict" bias (banning the
 * literal word "file" wasn't enough on its own -- models kept reaching for
 * synonyms like "different layers"/"different domains" to preserve the same
 * wrong heuristic), and 3 few-shot conversation-turn examples in domains
 * deliberately not overlapping the eval set (real message turns outperformed
 * the same examples described in prose). Scored 8/8 and 7/8 on the eval's
 * `semantic_gap` bucket (the actual target) with zero false positives across
 * every disparate/known-false-positive case tried. `dependency_collision`
 * and pure `touches`-overlap conflicts are deliberately NOT this module's
 * job -- `design-checks.ts` tiers 1/2 already catch those deterministically
 * for free; asking this comparator to also independently re-derive them
 * only produced confident, well-reasoned "these are complementary, not a
 * conflict" answers, because that's genuinely a different question ("is
 * there a build-order dependency" is not duplication, not a contradiction,
 * and not tension in shared behavior).
 *
 * Same fail-soft contract as `design-extract.ts`: one retry, then any error
 * or unparseable response returns `{conflict: false, ...}` rather than
 * throwing. This runs from a fire-and-forget background task after
 * `POST /v1/designs/check` has already responded (app.ts) -- a thrown error
 * here can't affect that response, but under-flagging on failure is still
 * the correct default for an advisory-only path (never invent a conflict
 * because the model was unreachable).
 */

import type { DesignStatement } from "@twing/core";
import { callLlmMessages, type ChatMessage } from "./llm-client.js";
// Moved to llm-prompts.ts (2026-10-10), alongside every other prompt this
// server sends, so they can be read in one place -- see that file's header.
import { SEMANTIC_CHECK_PROMPT as SYSTEM_PROMPT, SEMANTIC_CHECK_FEW_SHOT as FEW_SHOT } from "./llm-prompts.js";

const MAX_ATTEMPTS = 2;

export type SemanticConflictKind = "duplication" | "contradictory_assumptions" | "tension";

export interface SemanticConflictResult {
  conflict: boolean;
  kind: SemanticConflictKind | null;
  reason: string;
  /** One-line, human-readable recommendation for resolving the conflict,
   * surfaced verbatim in the Edit/Write gate's deny alongside `reason`.
   *
   * Advisory only. It never decides anything and never narrows the options
   * offered -- the model is describing a way out, not picking one, and the
   * menu still lists every resolution regardless of what this says.
   *
   * Empty when `conflict` is false, and empty when the model omits it:
   * `isValidResult` deliberately does not check this field, so a missing or
   * malformed value can never invalidate an otherwise-good conflict
   * judgment. Losing a real conflict signal over a cosmetic string would be
   * a far worse failure than showing no suggestion.
   *
   * Phrased about the two *plans*, never "yours"/"theirs": both sides of a
   * divergent pair are flagged and read the identical text. */
  suggestion: string;
}

export interface SemanticCheckOptions {
  /** Bedrock model id, e.g. "google.gemma-4-31b" -- see llm-client.ts's
   * bedrock-mantle routing (the only provider llm-client.ts speaks now). */
  model: string;
  region?: string;
}

const EMPTY_RESULT: SemanticConflictResult = { conflict: false, kind: null, reason: "", suggestion: "" };


/** `rawPlanExcerpt` if the design was registered from a real plan (the
 * full `rawPlanText`, untruncated as of 2026-08-18 -- see
 * `DesignStatement.rawPlanExcerpt`'s doc comment) *and hasn't been amended
 * since* (`scopeVersion <= 1`); otherwise synthesized from the structured
 * fields (a manually-registered design has nothing else). Found live,
 * 2026-08-18 (task #98): `rawPlanExcerpt` is captured once, at
 * registration, and never updated -- once `summary` starts accumulating
 * `Update:` entries via `amend --summary` (design-checks.ts's
 * `appendSummaryUpdate`), it's the more complete, more current text, and
 * unconditionally preferring the frozen `rawPlanExcerpt` snapshot meant the
 * semantic comparator kept reasoning over stale content even after a
 * session explicitly told the design coordinator its plan had changed.
 * `scopeVersion` starts at 1 on registration and is bumped by every
 * amend/resume, so `> 1` is exactly "has been amended at least once" --
 * see design-store.ts's `register`/`amend`. Exported so an eval harness
 * constructs input identically to production, rather than drifting from
 * it. */
export function planTextFor(design: DesignStatement): string {
  if (design.rawPlanExcerpt && design.scopeVersion <= 1) return design.rawPlanExcerpt;
  const lines = [`Summary: ${design.summary}`];
  if (design.creates.length > 0) lines.push(`Creates: ${design.creates.join(", ")}`);
  if (design.touches.length > 0) lines.push(`Touches: ${design.touches.join(", ")}`);
  if (design.dependsOn.length > 0) lines.push(`Depends on: ${design.dependsOn.join(", ")}`);
  return lines.join("\n");
}

function userTurn(candidateText: string, otherText: string): string {
  return `PLAN A:\n${candidateText}\n\n---\n\nPLAN B:\n${otherText}`;
}

/** `suggestion` is deliberately absent from this guard -- see the field's own
 * doc comment. `parseResult` normalizes it after this passes. */
function isValidResult(v: unknown): v is Omit<SemanticConflictResult, "suggestion"> {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  if (typeof obj.conflict !== "boolean") return false;
  if (obj.kind !== null && obj.kind !== "duplication" && obj.kind !== "contradictory_assumptions" && obj.kind !== "tension") return false;
  if (typeof obj.reason !== "string") return false;
  return true;
}

function parseResult(text: string): SemanticConflictResult | undefined {
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
  const raw = (parsed as Record<string, unknown>).suggestion;
  return { ...parsed, suggestion: typeof raw === "string" ? raw.trim() : "" };
}

function buildMessages(candidate: DesignStatement, other: DesignStatement): ChatMessage[] {
  const fewShotMessages: ChatMessage[] = FEW_SHOT.flatMap((ex) => [
    { role: "user", content: ex.user },
    { role: "assistant", content: ex.assistant },
  ]);
  return [
    { role: "system", content: SYSTEM_PROMPT },
    ...fewShotMessages,
    { role: "user", content: userTurn(planTextFor(candidate), planTextFor(other)) },
  ];
}

export async function checkSemanticConflict(candidate: DesignStatement, other: DesignStatement, options: SemanticCheckOptions): Promise<SemanticConflictResult> {
  const messages = buildMessages(candidate, other);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const text = await callLlmMessages(messages, {
        model: options.model,
        region: options.region,
        tag: {
          purpose: "semantic_check",
          designId: candidate.id,
          groupId: candidate.groupId,
          sessionId: candidate.sessionId,
          projectId: candidate.projectId,
          otherDesignId: other.id,
          otherGroupId: other.groupId,
        },
      });
      const parsed = parseResult(text);
      if (parsed) return parsed;
      console.warn(`twing serve: semantic conflict check returned malformed JSON (attempt ${attempt}/${MAX_ATTEMPTS})`);
    } catch (err) {
      console.warn(`twing serve: semantic conflict check call failed (attempt ${attempt}/${MAX_ATTEMPTS}): ${err instanceof Error ? err.message : err}`);
    }
  }
  return EMPTY_RESULT;
}
