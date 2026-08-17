import { test } from "node:test";
import assert from "node:assert/strict";
import { callLlm, callLlmMessages } from "./llm-client.js";

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

test("callLlm: routes to bedrock-mantle with the right path/model, extracts trimmed content", async () => {
  let capturedUrl = "";
  let capturedAuth = "";
  let capturedBody: unknown;
  await withBedrockToken("test-token", () =>
    withMockFetch(
      (async (url: string, init?: RequestInit) => {
        capturedUrl = url;
        capturedAuth = (init!.headers as Record<string, string>).authorization;
        capturedBody = JSON.parse(init!.body as string);
        return new Response(JSON.stringify({ choices: [{ message: { content: "  hi from bedrock  " } }] }), { status: 200 });
      }) as typeof fetch,
      async () => {
        const text = await callLlm("system prompt", "user prompt", { model: "google.gemma-4-31b", region: "us-east-1" });
        assert.equal(text, "hi from bedrock");
      },
    ),
  );
  assert.equal(capturedUrl, "https://bedrock-mantle.us-east-1.api.aws/openai/v1/chat/completions");
  assert.equal(capturedAuth, "Bearer test-token");
  assert.deepEqual((capturedBody as { messages: { role: string; content: string }[] }).messages, [
    { role: "system", content: "system prompt" },
    { role: "user", content: "user prompt" },
  ]);
});

test("callLlmMessages: passes the full message list through unmodified (few-shot support)", async () => {
  let capturedBody: unknown;
  const messages = [
    { role: "system" as const, content: "sys" },
    { role: "user" as const, content: "example input" },
    { role: "assistant" as const, content: "example output" },
    { role: "user" as const, content: "real input" },
  ];
  await withBedrockToken("test-token", () =>
    withMockFetch(
      (async (_url: string, init?: RequestInit) => {
        capturedBody = JSON.parse(init!.body as string);
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
      }) as typeof fetch,
      async () => {
        const text = await callLlmMessages(messages, { model: "m", region: "us-east-1" });
        assert.equal(text, "ok");
      },
    ),
  );
  assert.deepEqual((capturedBody as { messages: unknown }).messages, messages);
});

test("callLlm: unmapped model defaults to the plain /v1 path", async () => {
  let capturedUrl = "";
  await withBedrockToken("test-token", () =>
    withMockFetch(
      (async (url: string) => {
        capturedUrl = url;
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
      }) as typeof fetch,
      () => callLlm("s", "u", { model: "zai.glm-5", region: "us-east-1" }),
    ),
  );
  assert.equal(capturedUrl, "https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions");
});

test("callLlm: no AWS_BEARER_TOKEN_BEDROCK set throws before any network call", async () => {
  let called = false;
  await withBedrockToken(undefined, () =>
    withMockFetch(
      (async () => {
        called = true;
        throw new Error("should not be called");
      }) as typeof fetch,
      async () => {
        await assert.rejects(() => callLlm("s", "u", { model: "m", region: "us-east-1" }), /no credentials/);
      },
    ),
  );
  assert.equal(called, false);
});

test("callLlm: no region (option or env) throws before any network call", async () => {
  const originalRegion = process.env.AWS_REGION;
  const originalDefaultRegion = process.env.AWS_DEFAULT_REGION;
  delete process.env.AWS_REGION;
  delete process.env.AWS_DEFAULT_REGION;
  try {
    await withBedrockToken("test-token", async () => {
      await assert.rejects(() => callLlm("s", "u", { model: "m" }), /no region/);
    });
  } finally {
    if (originalRegion !== undefined) process.env.AWS_REGION = originalRegion;
    if (originalDefaultRegion !== undefined) process.env.AWS_DEFAULT_REGION = originalDefaultRegion;
  }
});

test("callLlm: non-ok response throws with the error message (caller's retry logic is responsible for catching it)", async () => {
  await withBedrockToken("test-token", () =>
    withMockFetch(
      (async () => new Response(JSON.stringify({ error: { message: "Operation not allowed" } }), { status: 403 })) as typeof fetch,
      async () => {
        await assert.rejects(() => callLlm("s", "u", { model: "m", region: "us-east-1" }), /Operation not allowed/);
      },
    ),
  );
});

test("callLlm: missing/unknown content resolves to empty string, not a throw", async () => {
  const text = await withBedrockToken("test-token", () =>
    withMockFetch(
      (async () => new Response(JSON.stringify({ choices: [] }), { status: 200 })) as typeof fetch,
      () => callLlm("s", "u", { model: "m", region: "us-east-1" }),
    ),
  );
  assert.equal(text, "");
});
