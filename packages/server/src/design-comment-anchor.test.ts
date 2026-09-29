import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_CONTEXT_CHARS, MAX_QUOTE_CHARS, validateCommentAnchor } from "./design-comment-anchor.js";

const design = {
  summary: "Add a retry budget to the HTTP client.\n\nUpdate (2026-09-27): Cap the budget per host so one slow host cannot starve the rest.",
  rawPlanExcerpt: "## Plan\n1. Add RetryBudget\n2. Wire it into   the client",
  changes: [{ id: "c1", action: "modify" as const, target: "src/net/retry.ts::RetryPolicy.backoff", intent: "cap exponential growth at 30s" }],
};

test("validateCommentAnchor: no anchor is a comment on the design as a whole", () => {
  assert.deepEqual(validateCommentAnchor(undefined, design), { ok: true });
  assert.deepEqual(validateCommentAnchor(null, design), { ok: true });
});

test("validateCommentAnchor: a quote from the summary is accepted, including across an amendment's paragraph break", () => {
  const result = validateCommentAnchor({ field: "summary", quote: "HTTP client. Update (2026-09-27): Cap the budget" }, design);
  assert.equal(result.ok, true);
});

test("validateCommentAnchor: whitespace is collapsed on both sides, nothing else is", () => {
  assert.equal(validateCommentAnchor({ field: "plan", quote: "Wire it into the client" }, design).ok, true, "the plan has three spaces there");
  const wrongCase = validateCommentAnchor({ field: "plan", quote: "wire it into the client" }, design);
  assert.equal(wrongCase.ok, false, "case is part of what was said");
});

test("validateCommentAnchor: a change anchor matches its target or its intent, and needs the change id", () => {
  assert.equal(validateCommentAnchor({ field: "change", changeId: "c1", quote: "exponential growth" }, design).ok, true);
  assert.equal(validateCommentAnchor({ field: "change", changeId: "c1", quote: "RetryPolicy.backoff" }, design).ok, true);

  const missingId = validateCommentAnchor({ field: "change", quote: "exponential growth" }, design);
  assert.deepEqual(missingId.ok ? undefined : missingId.status, 400);
});

test("validateCommentAnchor: words the design no longer says are a 409, so the reviewer reloads", () => {
  const stale = validateCommentAnchor({ field: "summary", quote: "a retry budget to the gRPC client" }, design);
  assert.equal(stale.ok, false);
  assert.equal(stale.ok ? undefined : stale.status, 409);

  const goneChange = validateCommentAnchor({ field: "change", changeId: "c-dropped", quote: "exponential growth" }, design);
  assert.equal(goneChange.ok ? undefined : goneChange.status, 409, "a change dropped by a re-registration is the same situation");
});

test("validateCommentAnchor: a plan anchor on a design with no plan text is stale, not a crash", () => {
  const result = validateCommentAnchor({ field: "plan", quote: "anything" }, { ...design, rawPlanExcerpt: undefined });
  assert.equal(result.ok ? undefined : result.status, 409);
});

test("validateCommentAnchor: malformed input is a 400", () => {
  for (const raw of ["summary", { field: "nope", quote: "x" }, { field: "summary" }, { field: "summary", quote: "   " }, { field: "summary", quote: "x".repeat(MAX_QUOTE_CHARS + 1) }]) {
    const result = validateCommentAnchor(raw, design);
    assert.equal(result.ok ? undefined : result.status, 400, JSON.stringify(raw).slice(0, 60));
  }
});

test("validateCommentAnchor: context is clipped to the characters nearest the quote, not refused", () => {
  const result = validateCommentAnchor({ field: "summary", quote: "retry budget", prefix: `${"p".repeat(200)}Add a `, suffix: ` to the HTTP${"s".repeat(200)}` }, design);
  assert.ok(result.ok && result.anchor);
  assert.equal(result.anchor.prefix?.length, MAX_CONTEXT_CHARS);
  assert.ok(result.anchor.prefix?.endsWith("Add a"), "the end of the prefix is what sits next to the quote");
  assert.ok(result.anchor.suffix?.startsWith("to the HTTP"));
  assert.equal(result.anchor.changeId, undefined, "only a change anchor carries a change id");
});
