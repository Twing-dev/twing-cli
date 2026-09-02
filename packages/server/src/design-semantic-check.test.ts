import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSemanticConflict, planTextFor } from "./design-semantic-check.js";
import { design } from "./design-eval-cases.js";

function withMockFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

function withBedrockEnv<T>(run: () => Promise<T>): Promise<T> {
  const originalToken = process.env.AWS_BEARER_TOKEN_BEDROCK;
  const originalRegion = process.env.AWS_REGION;
  process.env.AWS_BEARER_TOKEN_BEDROCK = "test-token";
  process.env.AWS_REGION = "us-east-1";
  return run().finally(() => {
    if (originalToken === undefined) delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    else process.env.AWS_BEARER_TOKEN_BEDROCK = originalToken;
    if (originalRegion === undefined) delete process.env.AWS_REGION;
    else process.env.AWS_REGION = originalRegion;
  });
}

function llmResponse(content: unknown) {
  return new Response(JSON.stringify({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] }), {
    status: 200,
  });
}

// -- planTextFor -----------------------------------------------------------

test("planTextFor: uses rawPlanExcerpt when present, ignores structured fields", () => {
  const d = design({ rawPlanExcerpt: "the real plan text", summary: "unused", creates: ["Unused"] });
  assert.equal(planTextFor(d), "the real plan text");
});

test("planTextFor: synthesizes from structured fields when there's no rawPlanExcerpt", () => {
  const d = design({ summary: "does a thing", creates: ["Foo"], touches: ["a.ts"], dependsOn: ["Bar"] });
  assert.equal(planTextFor(d), "Summary: does a thing\nCreates: Foo\nTouches: a.ts\nDepends on: Bar");
});

test("planTextFor: omits empty structured-field lines", () => {
  const d = design({ summary: "does a thing", creates: [], touches: [], dependsOn: [] });
  assert.equal(planTextFor(d), "Summary: does a thing");
});

// Task #98: rawPlanExcerpt is a one-shot registration-time snapshot that
// never updates, but `amend --summary` (design-checks.ts's
// appendSummaryUpdate) keeps summary current -- once a design has actually
// been amended (scopeVersion > 1), summary is the fresher, more complete
// text and should win, even though a never-amended ExitPlanMode
// registration still prefers rawPlanExcerpt (previous test).
test("planTextFor: prefers the (updated) summary over a stale rawPlanExcerpt once the design has been amended", () => {
  const d = design({ rawPlanExcerpt: "stale plan text from registration", summary: "original summary\n\nUpdate (2026-08-18): now also touches src/net/timeout.ts", scopeVersion: 2 });
  assert.equal(planTextFor(d), `Summary: ${d.summary}`);
});

// -- checkSemanticConflict --------------------------------------------------

test("checkSemanticConflict: conflict:true parses kind/reason, sends system+few-shot+real turn", async () => {
  let capturedMessages: { role: string; content: string }[] = [];
  const candidate = design({ id: "candidate", summary: "candidate plan" });
  const other = design({ id: "other", summary: "other plan" });

  const result = await withBedrockEnv(() =>
    withMockFetch(
      (async (_url: string, init?: RequestInit) => {
        capturedMessages = JSON.parse(init!.body as string).messages;
        return llmResponse({ conflict: true, kind: "tension", reason: "they fight over the same guarantee", suggestion: "pick one owner for the guarantee" });
      }) as typeof fetch,
      () => checkSemanticConflict(candidate, other, { model: "google.gemma-4-31b" }),
    ),
  );

  assert.deepEqual(result, { conflict: true, kind: "tension", reason: "they fight over the same guarantee", suggestion: "pick one owner for the guarantee" });
  assert.equal(capturedMessages[0].role, "system");
  // 3 few-shot pairs (6 messages) + the real user turn
  assert.equal(capturedMessages.length, 1 + 6 + 1);
  const realTurn = capturedMessages[capturedMessages.length - 1];
  assert.equal(realTurn.role, "user");
  assert.match(realTurn.content, /candidate plan/);
  assert.match(realTurn.content, /other plan/);
});

test("checkSemanticConflict: conflict:false parses cleanly", async () => {
  const result = await withBedrockEnv(() =>
    withMockFetch(
      (async () => llmResponse({ conflict: false, kind: null, reason: "unrelated", suggestion: "" })) as typeof fetch,
      () => checkSemanticConflict(design({ id: "a" }), design({ id: "b" }), { model: "google.gemma-4-31b" }),
    ),
  );
  assert.deepEqual(result, { conflict: false, kind: null, reason: "unrelated", suggestion: "" });
});

test("checkSemanticConflict: a missing suggestion field is tolerated and normalized to empty string", async () => {
  const result = await withBedrockEnv(() =>
    withMockFetch(
      (async () => llmResponse({ conflict: true, kind: "duplication", reason: "same thing twice" })) as typeof fetch,
      () => checkSemanticConflict(design({ id: "a" }), design({ id: "b" }), { model: "google.gemma-4-31b" }),
    ),
  );
  assert.deepEqual(result, { conflict: true, kind: "duplication", reason: "same thing twice", suggestion: "" });
});

test("checkSemanticConflict: a non-string suggestion is coerced to empty string, conflict still stands", async () => {
  const result = await withBedrockEnv(() =>
    withMockFetch(
      (async () => llmResponse({ conflict: true, kind: "duplication", reason: "r", suggestion: { bogus: 1 } })) as typeof fetch,
      () => checkSemanticConflict(design({ id: "a" }), design({ id: "b" }), { model: "google.gemma-4-31b" }),
    ),
  );
  assert.deepEqual(result, { conflict: true, kind: "duplication", reason: "r", suggestion: "" });
});

test("checkSemanticConflict: markdown-fenced JSON is unwrapped", async () => {
  const result = await withBedrockEnv(() =>
    withMockFetch(
      (async () => llmResponse("```json\n" + JSON.stringify({ conflict: true, kind: "duplication", reason: "r", suggestion: "s" }) + "\n```")) as typeof fetch,
      () => checkSemanticConflict(design({ id: "a" }), design({ id: "b" }), { model: "google.gemma-4-31b" }),
    ),
  );
  assert.deepEqual(result, { conflict: true, kind: "duplication", reason: "r", suggestion: "s" });
});

test("checkSemanticConflict: malformed JSON after one retry fails soft to no-conflict", async () => {
  let calls = 0;
  const result = await withBedrockEnv(() =>
    withMockFetch(
      (async () => {
        calls++;
        return llmResponse("not json at all");
      }) as typeof fetch,
      () => checkSemanticConflict(design({ id: "a" }), design({ id: "b" }), { model: "google.gemma-4-31b" }),
    ),
  );
  assert.deepEqual(result, { conflict: false, kind: null, reason: "", suggestion: "" });
  assert.equal(calls, 2);
});

test("checkSemanticConflict: an invalid kind value is rejected as malformed (fails soft after retry)", async () => {
  const result = await withBedrockEnv(() =>
    withMockFetch(
      (async () => llmResponse({ conflict: true, kind: "not_a_real_kind", reason: "r" })) as typeof fetch,
      () => checkSemanticConflict(design({ id: "a" }), design({ id: "b" }), { model: "google.gemma-4-31b" }),
    ),
  );
  assert.deepEqual(result, { conflict: false, kind: null, reason: "", suggestion: "" });
});

test("checkSemanticConflict: repeated network error fails soft to no-conflict, never throws", async () => {
  const result = await withBedrockEnv(() =>
    withMockFetch(
      (async () => {
        throw new Error("network down");
      }) as typeof fetch,
      () => checkSemanticConflict(design({ id: "a" }), design({ id: "b" }), { model: "google.gemma-4-31b" }),
    ),
  );
  assert.deepEqual(result, { conflict: false, kind: null, reason: "", suggestion: "" });
});

test("checkSemanticConflict: no AWS_BEARER_TOKEN_BEDROCK fails soft to no-conflict, never throws", async () => {
  const originalToken = process.env.AWS_BEARER_TOKEN_BEDROCK;
  delete process.env.AWS_BEARER_TOKEN_BEDROCK;
  try {
    const result = await checkSemanticConflict(design({ id: "a" }), design({ id: "b" }), { model: "google.gemma-4-31b", region: "us-east-1" });
    assert.deepEqual(result, { conflict: false, kind: null, reason: "", suggestion: "" });
  } finally {
    if (originalToken === undefined) delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    else process.env.AWS_BEARER_TOKEN_BEDROCK = originalToken;
  }
});
