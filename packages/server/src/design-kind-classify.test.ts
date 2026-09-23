import { test } from "node:test";
import assert from "node:assert/strict";
import type { DesignChange } from "@twing/core";
import { classifyChangeKinds } from "./design-kind-classify.js";
import { design } from "./design-eval-cases.js";

// Same harness the semantic-check tests use: swap `globalThis.fetch` and
// give the client a provider to select, so these exercise the real
// call/parse/retry path rather than a stubbed module boundary.

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

function change(overrides: Partial<DesignChange> & { id: string }): DesignChange {
  return { action: "modify", target: "src/a.ts", intent: "does a thing", kind: "code", ...overrides };
}

const OPTIONS = { model: "test-model" };

function designWith(changes: DesignChange[]) {
  return design({ changes });
}

test("classifyChangeKinds: returns the model's labels for the requested changes", async () => {
  const d = designWith([
    change({ id: "c1", target: "src/routes/WorkView.tsx", intent: "widen the top bar search box", kind: "api" }),
    change({ id: "c2", target: "src/db/models.py", intent: "add a column to the orders table", kind: "code" }),
  ]);

  const result = await withBedrockEnv(() =>
    withMockFetch((async () => llmResponse({ c1: "code", c2: "schema" })) as typeof fetch, () => classifyChangeKinds(d, ["c1", "c2"], OPTIONS)),
  );

  assert.deepEqual(result, { c1: "code", c2: "schema" });
});

test("classifyChangeKinds: only the requested ids are sent, and only they come back", async () => {
  // The caller passes the path-inferred subset; an author-declared kind is
  // never in `changeIds`, so it must not reach the prompt at all -- that is
  // the whole mechanism protecting it from being overturned.
  const d = designWith([
    change({ id: "c1", target: "src/routes/WorkView.tsx" }),
    change({ id: "c2", target: "src/api/users.ts", kind: "api" }), // author-declared, not requested
  ]);

  let sentBody = "";
  const result = await withBedrockEnv(() =>
    withMockFetch(
      (async (_url: unknown, init: unknown) => {
        sentBody = String((init as { body?: unknown }).body ?? "");
        // The model answers for an id nobody asked about, too.
        return llmResponse({ c1: "code", c2: "schema" });
      }) as unknown as typeof fetch,
      () => classifyChangeKinds(d, ["c1"], OPTIONS),
    ),
  );

  assert.deepEqual(result, { c1: "code" }, "an unrequested id is dropped, never applied");
  assert.ok(sentBody.includes("c1"), "the requested change is in the prompt");
  assert.ok(!sentBody.includes("src/api/users.ts"), "the unrequested change never reaches the model");
});

test("classifyChangeKinds: an off-list kind is dropped rather than coerced", async () => {
  // Silently rewriting it to "code" would bury real prompt/schema drift
  // under a plausible label; dropping leaves the existing guess in place.
  const d = designWith([change({ id: "c1" }), change({ id: "c2" })]);

  const result = await withBedrockEnv(() =>
    withMockFetch((async () => llmResponse({ c1: "wharrgarbl", c2: "docs" })) as typeof fetch, () => classifyChangeKinds(d, ["c1", "c2"], OPTIONS)),
  );

  assert.deepEqual(result, { c2: "docs" });
});

test("classifyChangeKinds: tolerates a fenced JSON response", async () => {
  const d = designWith([change({ id: "c1" })]);

  const result = await withBedrockEnv(() =>
    withMockFetch((async () => llmResponse('```json\n{"c1":"test"}\n```')) as typeof fetch, () => classifyChangeKinds(d, ["c1"], OPTIONS)),
  );

  assert.deepEqual(result, { c1: "test" });
});

test("classifyChangeKinds: retries once on malformed JSON, then gives up changing nothing", async () => {
  const d = designWith([change({ id: "c1" })]);
  let calls = 0;

  const result = await withBedrockEnv(() =>
    withMockFetch(
      (async () => {
        calls++;
        return llmResponse("not json at all");
      }) as typeof fetch,
      () => classifyChangeKinds(d, ["c1"], OPTIONS),
    ),
  );

  assert.equal(calls, 2, "one retry, matching design-extract/design-semantic-check");
  assert.deepEqual(result, {}, "an empty map means 'keep the path guess'");
});

test("classifyChangeKinds: a second attempt can still succeed", async () => {
  const d = designWith([change({ id: "c1" })]);
  let calls = 0;

  const result = await withBedrockEnv(() =>
    withMockFetch(
      (async () => {
        calls++;
        return calls === 1 ? llmResponse("garbage") : llmResponse({ c1: "docs" });
      }) as typeof fetch,
      () => classifyChangeKinds(d, ["c1"], OPTIONS),
    ),
  );

  assert.deepEqual(result, { c1: "docs" });
});

test("classifyChangeKinds: a throwing transport fails soft, never propagating", async () => {
  // This runs fire-and-forget after the response was already sent; a throw
  // here must never escape into an unhandled rejection.
  const d = designWith([change({ id: "c1" })]);

  const result = await withBedrockEnv(() =>
    withMockFetch(
      (async () => {
        throw new Error("network down");
      }) as typeof fetch,
      () => classifyChangeKinds(d, ["c1"], OPTIONS),
    ),
  );

  assert.deepEqual(result, {});
});

test("classifyChangeKinds: no requested ids means no call at all", async () => {
  const d = designWith([change({ id: "c1" })]);
  let calls = 0;

  const result = await withBedrockEnv(() =>
    withMockFetch(
      (async () => {
        calls++;
        return llmResponse({ c1: "docs" });
      }) as typeof fetch,
      async () => {
        const empty = await classifyChangeKinds(d, [], OPTIONS);
        // Also the case where every requested id has since vanished from the
        // design (an amend replaced the changes underneath a queued pass).
        const stale = await classifyChangeKinds(d, ["gone"], OPTIONS);
        return { empty, stale };
      },
    ),
  );

  assert.equal(calls, 0, "nothing to classify must not cost an LLM call");
  assert.deepEqual(result.empty, {});
  assert.deepEqual(result.stale, {});
});

test("classifyChangeKinds: a non-object JSON response changes nothing", async () => {
  const d = designWith([change({ id: "c1" })]);

  const result = await withBedrockEnv(() =>
    withMockFetch((async () => llmResponse('["code"]')) as typeof fetch, () => classifyChangeKinds(d, ["c1"], OPTIONS)),
  );

  assert.deepEqual(result, {}, "an array is not a changeId->kind map");
});

test("classifyChangeKinds: the prompt carries intent and goal, which is what it judges on", async () => {
  const d = design({
    summary: "Polish the dashboard's top bar",
    changes: [change({ id: "c1", target: "src/routes/WorkView.tsx", intent: "widen the top bar search box" })],
  });
  let sentBody = "";

  await withBedrockEnv(() =>
    withMockFetch(
      (async (_url: unknown, init: unknown) => {
        sentBody = String((init as { body?: unknown }).body ?? "");
        return llmResponse({ c1: "code" });
      }) as unknown as typeof fetch,
      () => classifyChangeKinds(d, ["c1"], OPTIONS),
    ),
  );

  assert.ok(sentBody.includes("widen the top bar search box"), "the declared intent is the primary signal");
  assert.ok(sentBody.includes("Polish the dashboard's top bar"), "the design's goal gives the change context");
});
