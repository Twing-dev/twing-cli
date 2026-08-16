#!/usr/bin/env node
// Live-network regression run of design-semantic-check.ts's comparator
// against the full labeled eval set (design-eval-cases.ts). NOT part of
// `npm test` (same reasoning as simulator/ needing real credentials) --
// this hits Bedrock for real, once per (candidate, openDesigns[i]) pair.
//
// Usage:
//   npm run build   # this imports from dist, not src
//   AWS_BEARER_TOKEN_BEDROCK=... AWS_REGION=us-east-1 node packages/server/scripts/run-semantic-eval.mjs
//
// Excludes the constraint_match category -- that's a deterministic
// path-vs-scope-glob match (tier 3), not a pairwise comparison, and was
// never in scope for this comparator (see design-semantic-check.ts's header
// comment for the same reasoning applied to dependency_collision).

import { checkSemanticConflict } from "../dist/design-semantic-check.js";
import { EVAL_CASES } from "../dist/design-eval-cases.js";

const model = process.env.TWING_SEMANTIC_CHECK_MODEL ?? "google.gemma-4-31b";
const region = process.env.AWS_REGION;

if (!process.env.AWS_BEARER_TOKEN_BEDROCK) {
  console.error("AWS_BEARER_TOKEN_BEDROCK not set -- this script needs real Bedrock credentials, exiting.");
  process.exit(1);
}

// Per-pair expected overrides where a case's single futureLlmExpectation
// doesn't apply uniformly across multiple openDesigns entries.
const PAIR_OVERRIDES = {
  "obvious-20-multi-design-mixed-tiers": { "open-tier1": true, "open-tier2": true, "open-unrelated": false },
  "obvious-21-multi-design-both-tier1": { "open-p": true, "open-q": true },
};

/** Matches app.ts's `rawPlanExcerpt: body.rawPlanText?.slice(0, RAW_PLAN_EXCERPT_CHARS)` --
 * a plan_mode-sourced eval case's provenance isn't wired onto its
 * `DesignStatement` directly (it's a separate field on the EvalCase, for
 * dataset readability), so reconstruct what registration would actually
 * have stored. */
const RAW_PLAN_EXCERPT_CHARS = 2000;
function withRawExcerpt(designStatement, rawPlanText) {
  if (!rawPlanText) return designStatement;
  return { ...designStatement, rawPlanExcerpt: rawPlanText.slice(0, RAW_PLAN_EXCERPT_CHARS) };
}

const pairs = [];
for (const c of EVAL_CASES) {
  if (c.category === "constraint_match") continue;
  const candidate = withRawExcerpt(c.candidate, c.planModeProvenance?.rawPlanText);
  const overrides = PAIR_OVERRIDES[c.id];
  c.openDesigns.forEach((open, idx) => {
    const other = idx === 0 ? withRawExcerpt(open, c.otherPlanModeProvenance?.rawPlanText) : open;
    const expected = overrides ? overrides[open.id] : c.futureLlmExpectation === "should_flag_as_conflict";
    pairs.push({ caseId: c.id, bucket: c.bucket, category: c.category, openId: open.id, candidate, other, expected });
  });
}

console.log(`${pairs.length} pairs, model=${model}, region=${region ?? "(from env)"}\n`);

const results = [];
for (const p of pairs) {
  process.stdout.write(`${p.caseId} vs ${p.openId}... `);
  const result = await checkSemanticConflict(p.candidate, p.other, { model, region });
  const correct = result.conflict === p.expected;
  console.log(`${result.conflict} (expected ${p.expected}) ${correct ? "OK" : "MISS"}`);
  results.push({ ...p, ...result, correct });
}

console.log("\n=== SUMMARY BY BUCKET ===");
for (const bucket of ["obvious_conflict", "disparate", "semantic_gap", "known_false_positive"]) {
  const subset = results.filter((r) => r.bucket === bucket);
  if (subset.length === 0) continue;
  const correct = subset.filter((r) => r.correct).length;
  console.log(`${bucket.padEnd(20)}: ${correct}/${subset.length}`);
}
const totalCorrect = results.filter((r) => r.correct).length;
console.log(`${"total".padEnd(20)}: ${totalCorrect}/${results.length}`);

console.log("\n=== MISSES ===");
for (const r of results.filter((r) => !r.correct)) {
  console.log(`\n${r.caseId} vs ${r.openId} (${r.bucket}/${r.category})`);
  console.log(`  expected=${r.expected} actual=${r.conflict} kind=${r.kind}`);
  console.log(`  reason: ${r.reason}`);
}
