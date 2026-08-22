import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runDesignChecks,
  matchConstraintsForPaths,
  pathInDesignScope,
  mergeDesignScope,
  appendSummaryUpdate,
  jaccard,
  PLAN_RETRY_SIMILARITY_THRESHOLD,
  overlapWaiverKey,
} from "./design-checks.js";
import type { DesignStatement, DesignConstraint } from "@twing/core";

function design(overrides: Partial<DesignStatement> = {}): DesignStatement {
  return {
    id: "d1",
    projectId: "p1",
    developerId: "dev1",
    sessionId: "s1",
    status: "open",
    createdAt: Date.now(),
    summary: "does something",
    creates: [],
    touches: [],
    dependsOn: [],
    ttlMs: 60_000,
    scopeVersion: 1,
    justifiedConstraintIds: [],
    justifiedOverlaps: [],
    lastActivityAt: Date.now(),
    ...overrides,
  };
}

test("clean when no overlap, no constraint match, no similarity", () => {
  const candidate = design({ id: "a", creates: ["Foo"], touches: ["src/foo.ts"] });
  const other = design({ id: "b", sessionId: "s2", creates: ["Bar"], touches: ["src/bar.ts"], summary: "totally unrelated" });
  const outcome = runDesignChecks(candidate, [other], []);
  assert.equal(outcome.verdict, "clean");
});

test("tier 1: exact creates overlap -> overlap verdict, warning severity", () => {
  const candidate = design({ id: "a", creates: ["RetryPolicy"] });
  const other = design({ id: "b", sessionId: "s2", developerId: "dev2", creates: ["RetryPolicy"] });
  const outcome = runDesignChecks(candidate, [other], []);
  assert.equal(outcome.verdict, "overlap");
  assert.equal(outcome.severity, "warning", "2026-08-19 severity split: tier 1 is display-only, never blocking");
  assert.equal(outcome.conflicts[0].overlapKind, "creates");
  assert.equal(outcome.conflicts[0].conflictingDesignId, "b");
});

test("tier 1: exact touches overlap -> overlap verdict, warning severity", () => {
  const candidate = design({ id: "a", touches: ["src/net/retry.ts"] });
  const other = design({ id: "b", sessionId: "s2", developerId: "dev2", touches: ["src/net/retry.ts"] });
  const outcome = runDesignChecks(candidate, [other], []);
  assert.equal(outcome.verdict, "overlap");
  assert.equal(outcome.severity, "warning");
  assert.equal(outcome.conflicts[0].overlapKind, "touches");
});

// 2026-08-22: same-developer pairs are excluded from every overlap/conflict
// tier that compares two designs (tiers 1 and 4 here; design-divergence.ts
// and checks.ts separately) -- see design-checks.ts's top-of-file comment.
test("tier 1: no overlap verdict when the 'other' design belongs to the same developer", () => {
  const candidate = design({ id: "a", developerId: "dev1", creates: ["RetryPolicy"], touches: ["src/net/retry.ts"] });
  const other = design({ id: "b", sessionId: "s2", developerId: "dev1", creates: ["RetryPolicy"], touches: ["src/net/retry.ts"] });
  const outcome = runDesignChecks(candidate, [other], []);
  assert.equal(outcome.verdict, "clean");
});

// Item 7's fix (2026-08-18): structural overlap approval memory --
// justifiedOverlaps, keyed per (conflictingDesignId, path), not per design
// pair. See design-store.test.ts for decideReview populating this field,
// and app.test.ts for the end-to-end justify->approve->retry flow.

// Every candidate/other pair below uses non-overlapping `summary` text
// (same "totally unrelated" pairing the file's very first test uses) --
// the default fixture's identical "does something" summary on both sides
// would otherwise itself trip tier 4's similarity fallback once tier 1
// is correctly silenced, masking what these tests are actually checking.

test("tier 1: a waived path stays quiet, but a second, different path on the same pair still flags", () => {
  const other = design({ id: "b", sessionId: "s2", developerId: "dev2", creates: ["file1.ts"], summary: "totally unrelated" });
  const waivedOnly = design({ id: "a", creates: ["file1.ts"], justifiedOverlaps: [overlapWaiverKey("b", "file1.ts")] });
  assert.equal(runDesignChecks(waivedOnly, [other], []).verdict, "clean");

  const otherWithBoth = design({ id: "b", sessionId: "s2", developerId: "dev2", creates: ["file1.ts", "file2.ts"], summary: "totally unrelated" });
  const waivedOnlyFile1 = design({ id: "a", creates: ["file1.ts", "file2.ts"], justifiedOverlaps: [overlapWaiverKey("b", "file1.ts")] });
  const outcome = runDesignChecks(waivedOnlyFile1, [otherWithBoth], []);
  assert.equal(outcome.verdict, "overlap");
  assert.equal(outcome.severity, "warning");
  assert.deepEqual(outcome.conflicts[0].overlapPaths, ["file2.ts"]);
});

test("tier 1: a waiver against design B doesn't leak to design C sharing the same path", () => {
  const candidate = design({ id: "a", creates: ["file1.ts"], justifiedOverlaps: [overlapWaiverKey("b", "file1.ts")] });
  const designC = design({ id: "c", sessionId: "s3", developerId: "dev3", creates: ["file1.ts"], summary: "totally unrelated" });
  const outcome = runDesignChecks(candidate, [designC], []);
  assert.equal(outcome.verdict, "overlap");
  assert.equal(outcome.severity, "warning");
  assert.equal(outcome.conflicts[0].conflictingDesignId, "c");
});

test("tier 3: constraint scope match -> constraint_flag", () => {
  const candidate = design({ id: "a", touches: ["src/net/retry.ts"] });
  const constraint: DesignConstraint = {
    id: "c1",
    projectId: "p1",
    type: "canonical_abstraction",
    statement: "use net/retry.ts, don't add another",
    scope: ["src/net/**"],
    source: "seeded",
    createdAt: Date.now(),
  };
  const outcome = runDesignChecks(candidate, [], [constraint]);
  assert.equal(outcome.verdict, "constraint_flag");
  assert.equal(outcome.severity, "error");
  assert.equal(outcome.constraints[0]?.statement, constraint.statement);
});

test("tier 4: summary similarity fallback only fires when 1-3 found nothing", () => {
  const candidate = design({ id: "a", summary: "adds a retry wrapper with exponential backoff for the payments client" });
  const other = design({ id: "b", sessionId: "s2", developerId: "dev2", summary: "adds a retry wrapper with exponential backoff for the billing client" });
  const outcome = runDesignChecks(candidate, [other], []);
  assert.equal(outcome.verdict, "overlap");
  assert.equal(outcome.severity, "error", "2026-08-19 severity split: tier 4 unchanged, still blocking, deliberately not demoted alongside tier 1");
  assert.match(outcome.conflicts[0].overlapDetail, /similar/);
});

test("tier 4 does not fire below the similarity threshold", () => {
  const candidate = design({ id: "a", summary: "adds a retry wrapper" });
  const other = design({ id: "b", sessionId: "s2", developerId: "dev2", summary: "renames a css variable" });
  const outcome = runDesignChecks(candidate, [other], []);
  assert.equal(outcome.verdict, "clean");
});

test("tier 4: no overlap verdict when the similar-sounding 'other' design belongs to the same developer", () => {
  const candidate = design({ id: "a", developerId: "dev1", summary: "adds a retry wrapper with exponential backoff for the payments client" });
  const other = design({ id: "b", sessionId: "s2", developerId: "dev1", summary: "adds a retry wrapper with exponential backoff for the billing client" });
  const outcome = runDesignChecks(candidate, [other], []);
  assert.equal(outcome.verdict, "clean");
});

// §17.9: the ground-truth per-path check, independent of any DesignStatement
// -- this is what backstops a review_required rule (e.g. packages/server/**)
// against a session whose registered design never mentions the path it's
// about to edit.
test("matchConstraintsForPaths: matches a bare path against a constraint's scope glob", () => {
  const constraint: DesignConstraint = {
    id: "c1",
    projectId: "p1",
    type: "review_required",
    statement: "the hosted coordinator -- do not remove without sign-off",
    scope: ["packages/server/**"],
    source: "seeded",
    createdAt: Date.now(),
  };
  const hits = matchConstraintsForPaths(["packages/server/src/app.ts"], [constraint]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.statement, constraint.statement);
  assert.equal(hits[0]?.type, "review_required");
});

test("matchConstraintsForPaths: no match returns an empty list", () => {
  const constraint: DesignConstraint = {
    id: "c1",
    projectId: "p1",
    type: "review_required",
    statement: "n/a",
    scope: ["packages/server/**"],
    source: "seeded",
    createdAt: Date.now(),
  };
  const hits = matchConstraintsForPaths(["packages/core/src/identity.ts"], [constraint]);
  assert.deepEqual(hits, []);
});

test("matchConstraintsForPaths: fires even when the path was never declared by any design", () => {
  // The scenario that slipped through in production: a session registers a
  // design about something else entirely, then edits a protected file. This
  // check takes the literal edited path directly -- it never sees or needs
  // a DesignStatement at all.
  const constraint: DesignConstraint = {
    id: "c1",
    projectId: "p1",
    type: "review_required",
    statement: "protected",
    scope: ["packages/server/**"],
    source: "seeded",
    createdAt: Date.now(),
  };
  const editedFilePath = "packages/server/src/design-checks.ts";
  const hits = matchConstraintsForPaths([editedFilePath], [constraint]);
  assert.equal(hits.length, 1);
});

// Item 8's fix (2026-08-22): two different target paths, each violating a
// different constraint, both come back from one call -- previously only the
// higher-priority hit surfaced, and the second was only discoverable by
// justifying the first and retrying. See matchConstraintsForPaths' own doc
// comment.
test("matchConstraintsForPaths: two different paths hitting two different constraints both come back in one call", () => {
  const reviewRequired: DesignConstraint = {
    id: "c1",
    projectId: "p1",
    type: "review_required",
    statement: "the hosted coordinator -- do not remove without sign-off",
    scope: ["packages/server/**"],
    source: "seeded",
    createdAt: Date.now(),
  };
  const canonicalAbstraction: DesignConstraint = {
    id: "c2",
    projectId: "p1",
    type: "canonical_abstraction",
    statement: "use the shared frame codec; don't invent a second wire format",
    scope: ["packages/core/src/framing.ts"],
    source: "seeded",
    createdAt: Date.now(),
  };
  const hits = matchConstraintsForPaths(
    ["packages/server/src/app.ts", "packages/core/src/framing.ts"],
    [canonicalAbstraction, reviewRequired],
  );
  assert.equal(hits.length, 2);
  // review_required still sorts first (higher priority), even though
  // canonical_abstraction was passed in first.
  assert.equal(hits[0]?.id, "c1");
  assert.equal(hits[1]?.id, "c2");
});

// Found live, 2026-08-11: a broad canonical_abstraction constraint on
// packages/** was seeded before a narrower review_required rule on
// packages/server/**, and the broad one won just by being first in the
// array -- masking the more important sign-off requirement.
test("matchConstraintsForPaths: review_required wins over canonical_abstraction even when the broader rule was seeded first", () => {
  const broad: DesignConstraint = {
    id: "c1",
    projectId: "p1",
    type: "canonical_abstraction",
    statement: "use the shared frame codec; don't invent a second wire format",
    scope: ["packages/**"],
    source: "seeded",
    createdAt: Date.now(),
  };
  const narrow: DesignConstraint = {
    id: "c2",
    projectId: "p1",
    type: "review_required",
    statement: "the hosted coordinator -- do not remove without sign-off",
    scope: ["packages/server/**"],
    source: "seeded",
    createdAt: Date.now(),
  };
  const hits = matchConstraintsForPaths(["packages/server/src/app.ts"], [broad, narrow]);
  assert.equal(hits[0]?.type, "review_required");
  assert.equal(hits[0]?.statement, narrow.statement);
});

// Deliberate behavior change (2026-08-22): the old single-hit version
// suppressed the broader same-type rule via this same specificity
// tie-break, since it only needed to pick one winner. Now that the
// function returns every match, both come back -- the tie-break just
// controls sort order (more specific first), not which one survives. See
// matchConstraintsForPaths' own doc comment.
test("matchConstraintsForPaths: among same-type matches, both come back, more specific (longer) scope sorted first", () => {
  const wide: DesignConstraint = {
    id: "c1",
    projectId: "p1",
    type: "review_required",
    statement: "wide rule",
    scope: ["packages/**"],
    source: "seeded",
    createdAt: Date.now(),
  };
  const specific: DesignConstraint = {
    id: "c2",
    projectId: "p1",
    type: "review_required",
    statement: "specific rule",
    scope: ["packages/server/**"],
    source: "seeded",
    createdAt: Date.now(),
  };
  const hits = matchConstraintsForPaths(["packages/server/src/app.ts"], [wide, specific]);
  assert.equal(hits.length, 2);
  assert.equal(hits[0]?.statement, "specific rule");
  assert.equal(hits[1]?.statement, "wide rule");
});

// §17 scope enforcement (2026-08): pathInDesignScope is the ground-truth
// backstop for a design's *own* claim -- same shape as matchConstraintsForPaths,
// but against creates/touches instead of a constraint's scope.

test("pathInDesignScope: exact match against touches", () => {
  const d = design({ touches: ["src/net/retry.ts"] });
  assert.equal(pathInDesignScope("src/net/retry.ts", d), true);
});

test("pathInDesignScope: exact match against creates", () => {
  const d = design({ creates: ["src/net/backoff.ts"] });
  assert.equal(pathInDesignScope("src/net/backoff.ts", d), true);
});

test("pathInDesignScope: glob match", () => {
  const d = design({ touches: ["src/net/**"] });
  assert.equal(pathInDesignScope("src/net/retry.ts", d), true);
});

test("pathInDesignScope: no match", () => {
  const d = design({ touches: ["src/net/retry.ts"] });
  assert.equal(pathInDesignScope("src/unrelated.ts", d), false);
});

test("mergeDesignScope: unions and dedups against the existing design", () => {
  const d = design({ touches: ["a.ts"], creates: ["Foo"], dependsOn: ["Bar"] });
  const merged = mergeDesignScope(d, { touches: ["a.ts", "b.ts"], creates: ["Baz"] });
  assert.deepEqual(merged.touches, ["a.ts", "b.ts"]);
  assert.deepEqual(merged.creates, ["Foo", "Baz"]);
  assert.deepEqual(merged.dependsOn, ["Bar"]); // untouched delta field stays as-is
});

test("mergeDesignScope: empty delta returns the design's existing scope unchanged", () => {
  const d = design({ touches: ["a.ts"], creates: ["Foo"], dependsOn: ["Bar"] });
  const merged = mergeDesignScope(d, {});
  assert.deepEqual(merged, { touches: ["a.ts"], creates: ["Foo"], dependsOn: ["Bar"] });
});

test("appendSummaryUpdate: appends as an Update entry, never drops the original text", () => {
  const result = appendSummaryUpdate("Add retry logic to the HTTP client.", "Also touches src/net/timeout.ts to share the same backoff config.");
  assert.match(result, /^Add retry logic to the HTTP client\./);
  assert.match(result, /Update \(\d{4}-\d{2}-\d{2}\): Also touches src\/net\/timeout\.ts to share the same backoff config\.$/);
});

test("appendSummaryUpdate: two successive amends both survive, in order", () => {
  const first = appendSummaryUpdate("original summary", "first update");
  const second = appendSummaryUpdate(first, "second update");
  const originalIndex = second.indexOf("original summary");
  const firstIndex = second.indexOf("first update");
  const secondIndex = second.indexOf("second update");
  assert.ok(originalIndex >= 0 && firstIndex > originalIndex && secondIndex > firstIndex, "expected original, then first update, then second update, in that order");
});

// -- jaccard / PLAN_RETRY_SIMILARITY_THRESHOLD ------------------------------
// Real empirical values this threshold was picked from (see the constant's
// own doc comment): identical text scores 1.0; a real plan substantively
// revised between two ExitPlanMode retries scored 0.815; unrelated plans
// scored 0.03-0.14. These tests don't reproduce that exact data (it lived in
// a live coordinator DB, not a fixture), but pin the same qualitative shape
// so a future change to the algorithm or the threshold has to notice it's
// crossing these lines.

test("jaccard: identical text scores 1.0", () => {
  const text = "Add a RetryPolicy class implementing exponential backoff with jitter for outbound HTTP calls.";
  assert.equal(jaccard(text, text), 1);
});

test("jaccard: completely disjoint vocabulary scores 0", () => {
  assert.equal(jaccard("alpha beta gamma delta", "epsilon zeta eta theta"), 0);
});

test("jaccard: empty string on either side scores 0, never divides by zero", () => {
  assert.equal(jaccard("", "some real plan text here"), 0);
  assert.equal(jaccard("some real plan text here", ""), 0);
  assert.equal(jaccard("", ""), 0);
});

test("jaccard: a substantively revised plan (real shape: ~40% growth, matching the real revised-retry sample this threshold was tuned from) clears PLAN_RETRY_SIMILARITY_THRESHOLD", () => {
  const before = [
    "Fix ExitPlanMode's duplicate-design-registration loop.",
    "Context: retrying ExitPlanMode within one plan-mode pass registers a brand-new design row every single time instead of updating the one from the previous attempt.",
    "Root cause: hook/design_gate.go's handleExitPlanMode unconditionally posts a fresh rawPlanText to POST /v1/designs/check on every call, with no local cache of a previously-registered design id for this session.",
    "POST /v1/designs/check calls DesignRegistry.register unconditionally, a plain crypto.randomUUID plus INSERT, never an upsert or a does-this-session-already-have-one lookup.",
    "The fix: repurpose the dead hasOpenForSession lookup into a real openPlanModeDesignForSession method, and add a full-replace reregisterFromPlan method that bumps scopeVersion and resets status to open.",
    "Wire this into POST /v1/designs/check: when rawPlanText is present, look up the existing candidate for this session first, and reregister in place rather than always inserting a new row.",
  ].join(" ");
  const addition =
    " Correctness note added after review: session id alone is not a reliable same-plan-retry signal, a session can legitimately register two different plan-mode designs back to back, " +
    "so the lookup needs a Jaccard similarity gate against the candidate's stored plan text before treating it as a match, otherwise a genuinely different later plan could silently overwrite an earlier unrelated design's content.";
  const after = before + addition;
  const similarity = jaccard(before, after);
  assert.ok(similarity >= PLAN_RETRY_SIMILARITY_THRESHOLD, `expected a substantively-revised-but-same plan (${similarity}) to clear the threshold (${PLAN_RETRY_SIMILARITY_THRESHOLD})`);
});

test("jaccard: two different plans that happen to share domain vocabulary stay below PLAN_RETRY_SIMILARITY_THRESHOLD", () => {
  const planA = "Add a RetryPolicy class to src/net/retry.ts implementing exponential backoff with jitter for outbound HTTP calls, depending on the existing Clock abstraction.";
  const planB = "Add a debounce helper to src/ui/search-box.ts so keystrokes don't trigger a network call on every character, using the existing Clock abstraction for timing.";
  const similarity = jaccard(planA, planB);
  assert.ok(similarity < PLAN_RETRY_SIMILARITY_THRESHOLD, `expected two different plans (${similarity}) to stay below the threshold (${PLAN_RETRY_SIMILARITY_THRESHOLD})`);
});
