import { test } from "node:test";
import assert from "node:assert/strict";
import { extractDesign } from "./design-extract.js";

function withMockFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

function withBedrockToken<T>(token: string | undefined, run: () => Promise<T>): Promise<T> {
  const original = process.env.AWS_BEARER_TOKEN_BEDROCK;
  if (token === undefined) delete process.env.AWS_BEARER_TOKEN_BEDROCK;
  else process.env.AWS_BEARER_TOKEN_BEDROCK = token;
  return run().finally(() => {
    if (original === undefined) delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    else process.env.AWS_BEARER_TOKEN_BEDROCK = original;
  });
}

// No upfront precheck in design-extract.ts itself anymore (that was
// OpenRouter-specific, removed 2026-08-17) -- but llm-client.ts's own
// callBedrock still throws before any fetch when AWS_BEARER_TOKEN_BEDROCK
// is unset, so "no credentials -> no network call" still holds, just one
// layer down. This is exactly the fail-soft path that produces the empty,
// no-summary designs found live when this server had no credentials wired
// in at all.
test("no AWS_BEARER_TOKEN_BEDROCK -> empty extraction, no network call", async () => {
  let called = false;
  await withBedrockToken(undefined, () =>
    withMockFetch(
      (async () => {
        called = true;
        throw new Error("should not be called");
      }) as typeof fetch,
      async () => {
        const result = await extractDesign("some plan text", { model: "m", region: "us-east-1" });
        assert.deepEqual(result, { creates: [], touches: [], dependsOn: [], summary: "" });
      },
    ),
  );
  assert.equal(called, false);
});

test("valid JSON response parses correctly", async () => {
  await withBedrockToken("test-token", () =>
    withMockFetch(
      (async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ creates: ["Foo"], touches: ["a.ts"], dependsOn: [], summary: "does foo" }) } }],
          }),
          { status: 200 },
        )) as typeof fetch,
      async () => {
        const result = await extractDesign("plan", { model: "m", region: "us-east-1" });
        assert.deepEqual(result, { creates: ["Foo"], touches: ["a.ts"], dependsOn: [], summary: "does foo" });
      },
    ),
  );
});

test("markdown-fenced JSON is unwrapped", async () => {
  await withBedrockToken("test-token", () =>
    withMockFetch(
      (async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "```json\n" + JSON.stringify({ creates: [], touches: [], dependsOn: [], summary: "s" }) + "\n```" } }],
          }),
          { status: 200 },
        )) as typeof fetch,
      async () => {
        const result = await extractDesign("plan", { model: "m", region: "us-east-1" });
        assert.equal(result.summary, "s");
      },
    ),
  );
});

test("malformed JSON after one retry fails soft to empty", async () => {
  let calls = 0;
  await withBedrockToken("test-token", () =>
    withMockFetch(
      (async () => {
        calls++;
        return new Response(JSON.stringify({ choices: [{ message: { content: "not json at all" } }] }), { status: 200 });
      }) as typeof fetch,
      async () => {
        const result = await extractDesign("plan", { model: "m", region: "us-east-1" });
        assert.deepEqual(result, { creates: [], touches: [], dependsOn: [], summary: "" });
      },
    ),
  );
  assert.equal(calls, 2);
});

test("network error fails soft to empty", async () => {
  await withBedrockToken("test-token", () =>
    withMockFetch(
      (async () => {
        throw new Error("network down");
      }) as typeof fetch,
      async () => {
        const result = await extractDesign("plan", { model: "m", region: "us-east-1" });
        assert.deepEqual(result, { creates: [], touches: [], dependsOn: [], summary: "" });
      },
    ),
  );
});

test("routes through bedrock-mantle with the right URL", async () => {
  await withBedrockToken("test-token", () =>
    withMockFetch(
      (async (url: string) => {
        assert.match(url, /^https:\/\/bedrock-mantle\.us-east-1\.api\.aws\/v1\/chat\/completions$/);
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ creates: ["Foo"], touches: ["a.ts"], dependsOn: [], summary: "does foo via bedrock" }) } }],
          }),
          { status: 200 },
        );
      }) as typeof fetch,
      async () => {
        const result = await extractDesign("plan", { model: "zai.glm-5", region: "us-east-1" });
        assert.deepEqual(result, { creates: ["Foo"], touches: ["a.ts"], dependsOn: [], summary: "does foo via bedrock" });
      },
    ),
  );
});

// Plan mode's half of the "every design carries changes[]" guarantee
// (2026-09-15). The prompt now asks for a fifth field; these pin that the
// parser carries it through, and -- more importantly -- that a model
// getting it wrong cannot regress the four fields the gate actually
// depends on. See design-changes.ts for what consumes it.
test("extraction carries the model's structured changes through", async () => {
  const changes = [{ id: "c1", action: "modify", kind: "code", target: "src/net/retry.ts::RetryPolicy.backoff", intent: "exponential, capped at 30s" }];
  await withBedrockToken("token", () =>
    withMockFetch(
      (async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ creates: [], touches: ["src/net/retry.ts"], dependsOn: [], summary: "s", changes }) } }],
          }),
          { status: 200 },
        )) as typeof fetch,
      async () => {
        const result = await extractDesign("plan", { model: "m", region: "us-east-1" });
        assert.deepEqual(result.changes, changes);
      },
    ),
  );
});

test("a malformed `changes` never costs the four fields the gate relies on", async () => {
  // The regression that would matter: adding item 5 to the prompt must not
  // make the whole ExitPlanMode path more likely to fail soft to "clean".
  // `changes` is deliberately excluded from parseExtraction's validation --
  // ensureChanges re-validates it later and derives from scope if it is
  // unusable.
  await withBedrockToken("token", () =>
    withMockFetch(
      (async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ creates: ["a.ts"], touches: [], dependsOn: [], summary: "s", changes: "not-a-list" }) } }],
          }),
          { status: 200 },
        )) as typeof fetch,
      async () => {
        const result = await extractDesign("plan", { model: "m", region: "us-east-1" });
        assert.deepEqual(result.creates, ["a.ts"], "scope survives a bad changes field");
        assert.equal(result.summary, "s");
      },
    ),
  );
});

test("an extraction with no changes has no `changes` key at all", async () => {
  // Absent-is-absent: an older model response must leave the type's shape
  // exactly as it was, not add a key holding undefined.
  await withBedrockToken("token", () =>
    withMockFetch(
      (async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify({ creates: [], touches: [], dependsOn: [], summary: "s" }) } }] }),
          { status: 200 },
        )) as typeof fetch,
      async () => {
        const result = await extractDesign("plan", { model: "m", region: "us-east-1" });
        assert.ok(!("changes" in result));
      },
    ),
  );
});
