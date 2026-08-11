import { test } from "node:test";
import assert from "node:assert/strict";
import { runDesignChecks, matchConstraintsForPaths } from "./design-checks.js";
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
    ...overrides,
  };
}

test("clean when no overlap, no constraint match, no similarity", () => {
  const candidate = design({ id: "a", creates: ["Foo"], touches: ["src/foo.ts"] });
  const other = design({ id: "b", sessionId: "s2", creates: ["Bar"], touches: ["src/bar.ts"], summary: "totally unrelated" });
  const outcome = runDesignChecks(candidate, [other], []);
  assert.equal(outcome.verdict, "clean");
});

test("tier 1: exact creates overlap -> overlap verdict", () => {
  const candidate = design({ id: "a", creates: ["RetryPolicy"] });
  const other = design({ id: "b", sessionId: "s2", creates: ["RetryPolicy"] });
  const outcome = runDesignChecks(candidate, [other], []);
  assert.equal(outcome.verdict, "overlap");
  assert.equal(outcome.conflicts[0].overlapKind, "creates");
  assert.equal(outcome.conflicts[0].conflictingDesignId, "b");
});

test("tier 1: exact touches overlap -> overlap verdict", () => {
  const candidate = design({ id: "a", touches: ["src/net/retry.ts"] });
  const other = design({ id: "b", sessionId: "s2", touches: ["src/net/retry.ts"] });
  const outcome = runDesignChecks(candidate, [other], []);
  assert.equal(outcome.verdict, "overlap");
  assert.equal(outcome.conflicts[0].overlapKind, "touches");
});

test("tier 2: dependency collision -- candidate creates what other depends on", () => {
  const candidate = design({ id: "a", creates: ["RetryPolicy"] });
  const other = design({ id: "b", sessionId: "s2", dependsOn: ["RetryPolicy"] });
  const outcome = runDesignChecks(candidate, [other], []);
  assert.equal(outcome.verdict, "overlap");
  assert.equal(outcome.conflicts[0].overlapKind, "depends_on");
});

test("tier 2: dependency collision -- other direction", () => {
  const candidate = design({ id: "a", dependsOn: ["Logger"] });
  const other = design({ id: "b", sessionId: "s2", creates: ["Logger"] });
  const outcome = runDesignChecks(candidate, [other], []);
  assert.equal(outcome.verdict, "overlap");
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
  assert.equal(outcome.constraint?.statement, constraint.statement);
});

test("tier 4: summary similarity fallback only fires when 1-3 found nothing", () => {
  const candidate = design({ id: "a", summary: "adds a retry wrapper with exponential backoff for the payments client" });
  const other = design({ id: "b", sessionId: "s2", summary: "adds a retry wrapper with exponential backoff for the billing client" });
  const outcome = runDesignChecks(candidate, [other], []);
  assert.equal(outcome.verdict, "overlap");
  assert.match(outcome.conflicts[0].overlapDetail, /similar/);
});

test("tier 4 does not fire below the similarity threshold", () => {
  const candidate = design({ id: "a", summary: "adds a retry wrapper" });
  const other = design({ id: "b", sessionId: "s2", summary: "renames a css variable" });
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
  const hit = matchConstraintsForPaths(["packages/server/src/app.ts"], [constraint]);
  assert.equal(hit?.statement, constraint.statement);
  assert.equal(hit?.type, "review_required");
});

test("matchConstraintsForPaths: no match returns undefined", () => {
  const constraint: DesignConstraint = {
    id: "c1",
    projectId: "p1",
    type: "review_required",
    statement: "n/a",
    scope: ["packages/server/**"],
    source: "seeded",
    createdAt: Date.now(),
  };
  const hit = matchConstraintsForPaths(["packages/core/src/identity.ts"], [constraint]);
  assert.equal(hit, undefined);
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
  const hit = matchConstraintsForPaths([editedFilePath], [constraint]);
  assert.notEqual(hit, undefined);
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
  const hit = matchConstraintsForPaths(["packages/server/src/app.ts"], [broad, narrow]);
  assert.equal(hit?.type, "review_required");
  assert.equal(hit?.statement, narrow.statement);
});

test("matchConstraintsForPaths: among same-type matches, the more specific (longer) scope wins", () => {
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
  const hit = matchConstraintsForPaths(["packages/server/src/app.ts"], [wide, specific]);
  assert.equal(hit?.statement, "specific rule");
});
