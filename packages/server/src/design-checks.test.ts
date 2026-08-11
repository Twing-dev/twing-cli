import { test } from "node:test";
import assert from "node:assert/strict";
import { runDesignChecks } from "./design-checks.js";
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
