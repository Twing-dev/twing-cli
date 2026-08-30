import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callLlm, callLlmMessages, describeLlmProvider, selectProvider } from "./llm-client.js";

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

// ---------------------------------------------------------------------------
// Multi-provider dispatch (design a4937c29): Bifrost / OpenRouter / Vertex
// alongside the default Bedrock path above.
// ---------------------------------------------------------------------------

const PROVIDER_ENV_KEYS = [
  "TWING_LLM_PROVIDER",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "TWING_BIFROST_BASE_URL",
  "TWING_BIFROST_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GCLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
] as const;

/** Clears every provider-selecting env var, applies `vars`, runs, restores.
 * Keeps `selectProvider`'s auto-detection deterministic regardless of what
 * the surrounding shell exported. */
function withEnv<T>(vars: Partial<Record<(typeof PROVIDER_ENV_KEYS)[number], string>>, run: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const k of PROVIDER_ENV_KEYS) {
    saved.set(k, process.env[k]);
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  return run().finally(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test("selectProvider: explicit TWING_LLM_PROVIDER wins over any detected credentials", async () => {
  await withEnv({ TWING_LLM_PROVIDER: "bifrost", AWS_BEARER_TOKEN_BEDROCK: "t", TWING_BIFROST_BASE_URL: "http://x" }, async () => {
    assert.equal(selectProvider(), "bifrost");
  });
  await withEnv({ TWING_LLM_PROVIDER: "  VERTEX  ", OPENROUTER_API_KEY: "k" }, async () => {
    assert.equal(selectProvider(), "vertex");
  });
});

test("selectProvider: auto-detect precedence is bedrock > bifrost > openrouter > vertex, bedrock as the fallback", async () => {
  await withEnv({ AWS_BEARER_TOKEN_BEDROCK: "t", TWING_BIFROST_BASE_URL: "http://x", OPENROUTER_API_KEY: "k" }, async () => {
    assert.equal(selectProvider(), "bedrock");
  });
  await withEnv({ TWING_BIFROST_BASE_URL: "http://x", OPENROUTER_API_KEY: "k" }, async () => {
    assert.equal(selectProvider(), "bifrost");
  });
  await withEnv({ OPENROUTER_API_KEY: "k", GOOGLE_APPLICATION_CREDENTIALS: "/tmp/sa.json" }, async () => {
    assert.equal(selectProvider(), "openrouter");
  });
  await withEnv({ GOOGLE_APPLICATION_CREDENTIALS: "/tmp/sa.json" }, async () => {
    assert.equal(selectProvider(), "vertex");
  });
  await withEnv({}, async () => {
    assert.equal(selectProvider(), "bedrock");
  });
});

test("bifrost: POST {base}/v1/chat/completions, {model,messages} body, trimmed content, no auth header when keyless", async () => {
  let capturedUrl = "";
  let capturedHeaders: Record<string, string> = {};
  let capturedBody: unknown;
  await withEnv({ TWING_BIFROST_BASE_URL: "http://localhost:8080" }, () =>
    withMockFetch(
      (async (url: string, init?: RequestInit) => {
        capturedUrl = url;
        capturedHeaders = init!.headers as Record<string, string>;
        capturedBody = JSON.parse(init!.body as string);
        return new Response(JSON.stringify({ choices: [{ message: { content: "  hi from bifrost  " } }] }), { status: 200 });
      }) as typeof fetch,
      async () => {
        const text = await callLlm("sys", "usr", { model: "openai/gpt-4o-mini" });
        assert.equal(text, "hi from bifrost");
      },
    ),
  );
  assert.equal(capturedUrl, "http://localhost:8080/v1/chat/completions");
  assert.equal(capturedHeaders.authorization, undefined);
  assert.equal(capturedHeaders["x-bf-vk"], undefined);
  assert.deepEqual(capturedBody, {
    model: "openai/gpt-4o-mini",
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "usr" },
    ],
  });
});

test("bifrost: trailing slash on TWING_BIFROST_BASE_URL is normalised", async () => {
  let capturedUrl = "";
  await withEnv({ TWING_BIFROST_BASE_URL: "http://localhost:8080/" }, () =>
    withMockFetch(
      (async (url: string) => {
        capturedUrl = url;
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
      }) as typeof fetch,
      () => callLlm("s", "u", { model: "m" }),
    ),
  );
  assert.equal(capturedUrl, "http://localhost:8080/v1/chat/completions");
});

test("bifrost: a sk-bf- key goes as x-bf-vk, anything else as Authorization: Bearer", async () => {
  let headers: Record<string, string> = {};
  const capture = (async (_url: string, init?: RequestInit) => {
    headers = init!.headers as Record<string, string>;
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  }) as typeof fetch;

  await withEnv({ TWING_BIFROST_BASE_URL: "http://x", TWING_BIFROST_API_KEY: "sk-bf-abc123" }, () =>
    withMockFetch(capture, () => callLlm("s", "u", { model: "m" })),
  );
  assert.equal(headers["x-bf-vk"], "sk-bf-abc123");
  assert.equal(headers.authorization, undefined);

  await withEnv({ TWING_BIFROST_BASE_URL: "http://x", TWING_BIFROST_API_KEY: "sk-live-xyz" }, () =>
    withMockFetch(capture, () => callLlm("s", "u", { model: "m" })),
  );
  assert.equal(headers.authorization, "Bearer sk-live-xyz");
  assert.equal(headers["x-bf-vk"], undefined);
});

test("bifrost: non-ok response throws with the error message", async () => {
  await withEnv({ TWING_BIFROST_BASE_URL: "http://x" }, () =>
    withMockFetch(
      (async () => new Response(JSON.stringify({ error: { message: "model not found" } }), { status: 500 })) as typeof fetch,
      async () => {
        await assert.rejects(() => callLlm("s", "u", { model: "m" }), /Bifrost request failed \(500\): model not found/);
      },
    ),
  );
});

test("openrouter: routes to openrouter.ai with Bearer OPENROUTER_API_KEY and passes the full message list", async () => {
  let capturedUrl = "";
  let capturedAuth = "";
  let capturedBody: unknown;
  const messages = [
    { role: "system" as const, content: "sys" },
    { role: "user" as const, content: "a" },
    { role: "assistant" as const, content: "b" },
    { role: "user" as const, content: "c" },
  ];
  await withEnv({ OPENROUTER_API_KEY: "or-key" }, () =>
    withMockFetch(
      (async (url: string, init?: RequestInit) => {
        capturedUrl = url;
        capturedAuth = (init!.headers as Record<string, string>).authorization;
        capturedBody = JSON.parse(init!.body as string);
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
      }) as typeof fetch,
      () => callLlmMessages(messages, { model: "openai/gpt-4o-mini" }),
    ),
  );
  assert.equal(capturedUrl, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(capturedAuth, "Bearer or-key");
  assert.deepEqual((capturedBody as { messages: unknown }).messages, messages);
});

test("openrouter: OPENROUTER_BASE_URL override is honoured", async () => {
  let capturedUrl = "";
  await withEnv({ OPENROUTER_API_KEY: "k", OPENROUTER_BASE_URL: "https://proxy.internal/or/v1/" }, () =>
    withMockFetch(
      (async (url: string) => {
        capturedUrl = url;
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
      }) as typeof fetch,
      () => callLlm("s", "u", { model: "m" }),
    ),
  );
  assert.equal(capturedUrl, "https://proxy.internal/or/v1/chat/completions");
});

test("openrouter: no OPENROUTER_API_KEY throws before any network call", async () => {
  let called = false;
  await withEnv({ TWING_LLM_PROVIDER: "openrouter" }, () =>
    withMockFetch(
      (async () => {
        called = true;
        throw new Error("should not be called");
      }) as typeof fetch,
      async () => {
        await assert.rejects(() => callLlm("s", "u", { model: "m" }), /no credentials/);
      },
    ),
  );
  assert.equal(called, false);
});

test("vertex: mints an access token from the SA key via jwt-bearer, then calls the OpenAI-compat endpoint; token is cached", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const dir = mkdtempSync(join(tmpdir(), "twing-vertex-"));
  const saPath = join(dir, "sa.json");
  writeFileSync(saPath, JSON.stringify({ client_email: "svc@proj.iam.gserviceaccount.com", private_key: pem }));

  let tokenExchangeCalls = 0;
  let aiCalls = 0;
  let aiUrl = "";
  let aiAuth = "";
  let aiBody: unknown;
  const impl = (async (url: string, init?: RequestInit) => {
    if (url === "https://oauth2.googleapis.com/token") {
      tokenExchangeCalls++;
      const params = new URLSearchParams(init!.body as string);
      assert.equal(params.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
      assert.match(params.get("assertion") ?? "", /^[\w-]+\.[\w-]+\.[\w-]+$/);
      return new Response(JSON.stringify({ access_token: "ya29.fake", expires_in: 3600 }), { status: 200 });
    }
    aiCalls++;
    aiUrl = url;
    aiAuth = (init!.headers as Record<string, string>).authorization;
    aiBody = JSON.parse(init!.body as string);
    return new Response(JSON.stringify({ choices: [{ message: { content: "  hi from vertex  " } }] }), { status: 200 });
  }) as typeof fetch;

  await withEnv(
    { GOOGLE_APPLICATION_CREDENTIALS: saPath, GOOGLE_CLOUD_PROJECT: "proj", GOOGLE_CLOUD_LOCATION: "us-central1" },
    () =>
      withMockFetch(impl, async () => {
        const a = await callLlm("s", "u", { model: "google/gemini-2.0-flash" });
        const b = await callLlm("s", "u", { model: "google/gemini-2.0-flash" });
        assert.equal(a, "hi from vertex");
        assert.equal(b, "hi from vertex");
      }),
  );

  assert.equal(
    aiUrl,
    "https://us-central1-aiplatform.googleapis.com/v1/projects/proj/locations/us-central1/endpoints/openapi/chat/completions",
  );
  assert.equal(aiAuth, "Bearer ya29.fake");
  assert.deepEqual((aiBody as { model: string }).model, "google/gemini-2.0-flash");
  assert.equal(aiCalls, 2);
  assert.equal(tokenExchangeCalls, 1, "access token should be cached across calls");
});

test("vertex: no GOOGLE_APPLICATION_CREDENTIALS throws before any network call", async () => {
  let called = false;
  await withEnv({ TWING_LLM_PROVIDER: "vertex", GOOGLE_CLOUD_PROJECT: "proj" }, () =>
    withMockFetch(
      (async () => {
        called = true;
        throw new Error("should not be called");
      }) as typeof fetch,
      async () => {
        await assert.rejects(() => callLlm("s", "u", { model: "m" }), /no credentials/);
      },
    ),
  );
  assert.equal(called, false);
});

test("describeLlmProvider: reports the active provider and whether it looks configured", async () => {
  await withEnv({ TWING_BIFROST_BASE_URL: "http://localhost:8080", TWING_BIFROST_API_KEY: "sk-bf-x" }, async () => {
    const d = describeLlmProvider();
    assert.equal(d.provider, "bifrost");
    assert.equal(d.ready, true);
    assert.match(d.summary, /virtual key/);
  });
  await withEnv({ TWING_LLM_PROVIDER: "vertex" }, async () => {
    const d = describeLlmProvider();
    assert.equal(d.provider, "vertex");
    assert.equal(d.ready, false);
  });
});
