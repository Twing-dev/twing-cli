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
