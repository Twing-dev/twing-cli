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

const MAX_ATTEMPTS = 2;

export type SemanticConflictKind = "duplication" | "contradictory_assumptions" | "tension";

export interface SemanticConflictResult {
  conflict: boolean;
  kind: SemanticConflictKind | null;
  reason: string;
}

export interface SemanticCheckOptions {
  /** Bedrock model id, e.g. "google.gemma-4-31b" -- see llm-client.ts's
   * bedrock-mantle routing. This module is fixed to provider "bedrock": no
   * OpenRouter flexibility needed here, production runs on Bedrock credits. */
  model: string;
  region?: string;
}

const EMPTY_RESULT: SemanticConflictResult = { conflict: false, kind: null, reason: "" };

const SYSTEM_PROMPT = [
  "You are comparing two independent implementation plans for the same codebase, written by different developers who have not seen each other's plan.",
  "",
  "The plans are in CONFLICT if, and only if, at least one of these is true:",
  "a) Duplication: they build overlapping or duplicate functionality -- the same underlying problem is being solved independently, twice.",
  "b) Contradictory assumptions: something one plan assumes or asserts to be true, the other plan makes false, or assumes to be false.",
  "c) Tension in system changes: the way one plan changes shared system behavior, data, or contracts is in tension with how the other plan changes or depends on that same thing.",
  "",
  "Otherwise, they are not in conflict -- even if they touch related areas of the codebase or share vocabulary.",
  "",
  "Plans can duplicate work or conflict even when they touch completely different files, components, or layers of the system. Do not treat different file paths, or 'different layer/component' framing, as evidence of no conflict by itself -- judge (a)/(b)/(c) on what each plan actually does, not on whether their file lists overlap.",
  "",
  'Return JSON only: {"conflict": boolean, "kind": "duplication"|"contradictory_assumptions"|"tension"|null, "reason": string}.',
  "reason is required in all cases (even conflict: false) -- one or two sentences, concrete, naming the specific detail from each plan that drove your answer.",
  "No prose outside the JSON, no markdown code fences.",
].join("\n");

// Fresh domains, deliberately not overlapping design-eval-cases.ts's fixtures
// (retry/backoff, debounce, XSS sanitization, pagination, activity-log
// retention/audit, sync/async verdicts) -- these are meant to teach the
// *shape* of each conflict kind, not hand the model an answer to a
// near-identical test case.
const FEW_SHOT: { user: string; assistant: string }[] = [
  {
    user: [
      "PLAN A:",
      "Summary: Add an in-memory LRU cache inside UserProfileService.getProfile() so repeated profile lookups within a request don't re-hit the database.",
      "Touches: src/services/user-profile-service.ts",
      "",
      "---",
      "",
      "PLAN B:",
      "Summary: Add an in-memory LRU cache inside OrderService.getOrderHistory() so repeated order-history lookups within a request don't re-hit the database.",
      "Touches: src/services/order-service.ts",
    ].join("\n"),
    assistant: JSON.stringify({
      conflict: true,
      kind: "duplication",
      reason:
        "Both plans independently build the same thing -- a per-request LRU read-through cache wrapper around a service method -- in different files. They're the same underlying problem (repeated lookups within a request) solved twice with two divergent implementations instead of one shared utility, even though the files and services are unrelated.",
    }),
  },
  {
    user: [
      "PLAN A:",
      "Summary: Add a SESSION_IDLE_TIMEOUT_MINUTES config knob; the session-refresh middleware checks lastActivityAt on every request and force-logs-out the session once it's been idle longer than that.",
      "Touches: src/auth/session-refresh-middleware.ts",
      "",
      "---",
      "",
      "PLAN B:",
      "Summary: Add a 'stay signed in for 30 days' remember-me option -- issues a long-lived refresh token flagged long_lived, and the session-expiry check skips its normal checks for tokens with that flag.",
      "Touches: src/auth/refresh-token.ts",
    ].join("\n"),
    assistant: JSON.stringify({
      conflict: true,
      kind: "tension",
      reason:
        "Plan A's idle-timeout enforcement lives in the session-refresh middleware and isn't described as aware of Plan B's long_lived flag, while Plan B's skip is described as bypassing 'the normal session-expiry check' without naming the idle-timeout path specifically -- if idle-timeout isn't part of what Plan B's skip covers, a remembered session could get silently logged out despite the 30-day promise; if it is, Plan A's security control gets silently bypassed for those sessions. Either reading is a real tension between the two mechanisms, not a stated agreement about which wins.",
    }),
  },
  {
    user: [
      "PLAN A:",
      "Summary: Add a ThemePreviewBanner component, shown only in Storybook, so designers can preview typography tokens against real components.",
      "Touches: src/dev/storybook/theme-preview-banner.tsx",
      "",
      "---",
      "",
      "PLAN B:",
      "Summary: Add a KeyboardShortcutsCheatSheet modal, triggered by pressing '?' anywhere in the app, listing available keyboard shortcuts.",
      "Touches: src/ui/keyboard-shortcuts-cheat-sheet.tsx",
    ].join("\n"),
    assistant: JSON.stringify({
      conflict: false,
      kind: null,
      reason:
        "Both are small, independent UI additions with no shared data, no shared contract, and no overlapping problem -- a Storybook-only dev preview tool and a runtime keyboard-shortcuts modal don't build the same thing, assume anything about each other, or change any behavior the other depends on.",
    }),
  },
];

/** `rawPlanExcerpt` if the design was registered from a real plan (up to
 * 2000 chars, app.ts's RAW_PLAN_EXCERPT_CHARS); otherwise synthesized from
 * the structured fields a manually-registered design has instead. Exported
 * so an eval harness constructs input identically to production, rather
 * than drifting from it. */
export function planTextFor(design: DesignStatement): string {
  if (design.rawPlanExcerpt) return design.rawPlanExcerpt;
  const lines = [`Summary: ${design.summary}`];
  if (design.creates.length > 0) lines.push(`Creates: ${design.creates.join(", ")}`);
  if (design.touches.length > 0) lines.push(`Touches: ${design.touches.join(", ")}`);
  if (design.dependsOn.length > 0) lines.push(`Depends on: ${design.dependsOn.join(", ")}`);
  return lines.join("\n");
}

function userTurn(candidateText: string, otherText: string): string {
  return `PLAN A:\n${candidateText}\n\n---\n\nPLAN B:\n${otherText}`;
}

function isValidResult(v: unknown): v is SemanticConflictResult {
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
  return isValidResult(parsed) ? parsed : undefined;
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
      const text = await callLlmMessages(messages, { provider: "bedrock", model: options.model, region: options.region });
      const parsed = parseResult(text);
      if (parsed) return parsed;
      console.warn(`twing serve: semantic conflict check returned malformed JSON (attempt ${attempt}/${MAX_ATTEMPTS})`);
    } catch (err) {
      console.warn(`twing serve: semantic conflict check call failed (attempt ${attempt}/${MAX_ATTEMPTS}): ${err instanceof Error ? err.message : err}`);
    }
  }
  return EMPTY_RESULT;
}
