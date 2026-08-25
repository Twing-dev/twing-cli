import { test } from "node:test";
import assert from "node:assert/strict";
import type { PendingReview, DesignStatement, DesignConstraint } from "@twing/core";
import { enrichReview, enrichReviews } from "./review-enrich.js";

function design(id: string, over: Partial<DesignStatement> = {}): DesignStatement {
  return {
    id,
    projectId: "proj",
    developerId: "priya@team.dev",
    sessionId: "sess",
    status: "flagged",
    createdAt: 1,
    lastActivityAt: 1,
    scopeVersion: 1,
    summary: "add retry with exponential backoff to the webhook client",
    creates: ["src/net/retry.ts"],
    touches: ["src/billing/charge.ts"],
    dependsOn: [],
    ttlMs: 1,
    ...over,
  } as DesignStatement;
}

function constraint(id: string, over: Partial<DesignConstraint> = {}): DesignConstraint {
  return {
    id,
    projectId: "proj",
    type: "review_required",
    statement: "money paths need a second pair of eyes",
    scope: ["src/billing/**"],
    source: ".twing/twing.yml",
    createdAt: 1,
    ...over,
  } as DesignConstraint;
}

function review(over: Partial<PendingReview> = {}): PendingReview {
  return {
    id: "rev_1",
    designId: "dsn_mine",
    projectId: "proj",
    justification: "webhook retries need different backoff to API retries",
    createdAt: 1,
    ...over,
  };
}

const none = () => undefined;

test("carries the design through, so a reviewer sees the work and not just the argument for it", () => {
  const out = enrichReview(review(), (id) => (id === "dsn_mine" ? design("dsn_mine") : undefined), none);

  assert.equal(out.design?.summary, "add retry with exponential backoff to the webhook client");
  assert.equal(out.design?.developerId, "priya@team.dev");
  assert.deepEqual(out.design?.touches, ["src/billing/charge.ts"]);
  assert.equal(out.design?.status, "flagged");
  // The original fields must survive untouched -- this is a superset, not a
  // replacement shape.
  assert.equal(out.justification, "webhook retries need different backoff to API retries");
  assert.equal(out.id, "rev_1");
});

test("resolves constraint ids into the actual rule text", () => {
  const out = enrichReview(
    review({ constraintIds: ["c1"] }),
    none,
    (id) => (id === "c1" ? constraint("c1") : undefined),
  );

  assert.equal(out.constraints?.length, 1);
  assert.equal(out.constraints?.[0].statement, "money paths need a second pair of eyes");
  assert.equal(out.constraints?.[0].type, "review_required");
});

test("merges overlap and semantic-conflict waivers into one list, keeping which check produced each", () => {
  const out = enrichReview(
    review({
      overlapWaivers: [{ conflictingDesignId: "dsn_other", paths: ["src/billing/charge.ts"] }],
      conflictWaivers: [{ conflictingDesignId: "dsn_third" }],
    }),
    (id) =>
      id === "dsn_other"
        ? design("dsn_other", { summary: "billing retry work", developerId: "ayush@team.dev" })
        : id === "dsn_third"
          ? design("dsn_third", { summary: "webhook rework", developerId: "sam@team.dev" })
          : undefined,
    none,
  );

  assert.equal(out.conflicts?.length, 2);
  assert.equal(out.conflicts?.[0].kind, "overlap");
  assert.equal(out.conflicts?.[0].summary, "billing retry work");
  assert.deepEqual(out.conflicts?.[0].paths, ["src/billing/charge.ts"]);
  // A semantic conflict has no specific colliding path to name.
  assert.equal(out.conflicts?.[1].kind, "conflict");
  assert.equal(out.conflicts?.[1].developerId, "sam@team.dev");
  assert.equal(out.conflicts?.[1].paths, undefined);
});

// The listing must survive rows that reference things which no longer
// exist: `twing constraints remove` is unilateral and immediate, and a
// design can be deleted after a review was raised against it. Neither may
// take down the whole page.
test("a review whose design is gone still enriches, minus the design", () => {
  const out = enrichReview(review(), none, none);

  assert.equal(out.design, undefined);
  assert.equal(out.justification, "webhook retries need different backoff to API retries");
});

test("a constraint removed since the review was raised is dropped, not rendered as a bare id", () => {
  const out = enrichReview(review({ constraintIds: ["gone", "c1"] }), none, (id) =>
    id === "c1" ? constraint("c1") : undefined,
  );

  assert.equal(out.constraints?.length, 1);
  assert.equal(out.constraints?.[0].id, "c1");
});

test("a conflicting design that's gone keeps its id, so the reviewer still knows something collided", () => {
  const out = enrichReview(
    review({ overlapWaivers: [{ conflictingDesignId: "dsn_gone", paths: ["a.ts"] }] }),
    none,
    none,
  );

  assert.equal(out.conflicts?.length, 1);
  assert.equal(out.conflicts?.[0].designId, "dsn_gone");
  assert.equal(out.conflicts?.[0].summary, undefined);
});

test("omits empty collections entirely rather than sending empty arrays", () => {
  const out = enrichReview(review(), none, none);

  assert.equal(out.constraints, undefined);
  assert.equal(out.conflicts, undefined);
});

test("enrichReviews preserves order", () => {
  const out = enrichReviews(
    [review({ id: "a" }), review({ id: "b" }), review({ id: "c" })],
    none,
    none,
  );

  assert.deepEqual(out.map((r) => r.id), ["a", "b", "c"]);
});
