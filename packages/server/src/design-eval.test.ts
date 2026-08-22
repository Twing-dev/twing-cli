/**
 * Harness for design-eval-cases.ts (statefulness/eval work, 2026-08). Runs
 * every labeled case through today's real runDesignChecks and reports four
 * distinct buckets, not one pass/fail count -- see design-eval-cases.ts's
 * header comment for what each bucket means.
 *
 * obvious_conflict/disparate are real regression coverage: a failure here
 * is a bug. semantic_gap/known_false_positive assert today's *known*
 * behavior on purpose -- they are not bugs to fix in this file. If one of
 * those ever starts failing, that's good news (a tier started catching
 * something it structurally couldn't before, or stopped over-firing) --
 * move the case to obvious_conflict/disparate and update its
 * expectedVerdict/category, rather than deleting the assertion.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runDesignChecks } from "./design-checks.js";
import { EVAL_CASES, type EvalCase } from "./design-eval-cases.js";

function outcomeFor(c: EvalCase) {
  return runDesignChecks(c.candidate, c.openDesigns, c.constraints ?? []);
}

for (const c of EVAL_CASES.filter((c) => c.bucket === "obvious_conflict")) {
  test(`[obvious] ${c.id} (${c.source}): sync catches it -- ${c.rationale}`, () => {
    const outcome = outcomeFor(c);
    assert.equal(outcome.verdict, c.expectedVerdict);
    if (c.expectedOverlapKind) assert.equal(outcome.conflicts[0]?.overlapKind, c.expectedOverlapKind);
    if (c.expectedConstraintType) assert.equal(outcome.constraints[0]?.type, c.expectedConstraintType);
    if (c.expectedConstraintStatement) assert.equal(outcome.constraints[0]?.statement, c.expectedConstraintStatement);
    if (c.expectedConflictCount !== undefined) assert.equal(outcome.conflicts.length, c.expectedConflictCount);
  });
}

for (const c of EVAL_CASES.filter((c) => c.bucket === "disparate")) {
  test(`[disparate] ${c.id} (${c.source}): sync stays clean -- ${c.rationale}`, () => {
    assert.equal(outcomeFor(c).verdict, "clean");
  });
}

for (const c of EVAL_CASES.filter((c) => c.bucket === "semantic_gap")) {
  test(`[semantic_gap -- CONFIRMED MISS, future-LLM-path target] ${c.id} (${c.source}): ${c.rationale}`, () => {
    assert.equal(outcomeFor(c).verdict, "clean");
  });
}

for (const c of EVAL_CASES.filter((c) => c.bucket === "known_false_positive")) {
  test(`[known_false_positive -- tier 4 over-fires] ${c.id} (${c.source}): ${c.rationale}`, () => {
    assert.notEqual(outcomeFor(c).verdict, "clean");
  });
}

test("design eval dataset: full bucketed report", () => {
  assert.ok(EVAL_CASES.length > 0);
  const byBucket = new Map<string, Record<string, unknown>[]>();
  for (const c of EVAL_CASES) {
    const outcome = outcomeFor(c);
    const list = byBucket.get(c.bucket) ?? [];
    list.push({
      id: c.id,
      source: c.source,
      category: c.category,
      expected: c.expectedVerdict,
      actual: outcome.verdict,
      futureLlmExpectation: c.futureLlmExpectation,
    });
    byBucket.set(c.bucket, list);
  }
  for (const [bucket, rows] of byBucket) {
    console.log(`\n=== ${bucket} (${rows.length}) ===`);
    console.table(rows);
  }
});
