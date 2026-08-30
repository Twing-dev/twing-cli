import { test } from "node:test";
import assert from "node:assert/strict";
import {
  callLlm,
  callLlmMessages,
  describeLlmProvider,
  resolveExtractModel,
  resolveSemanticCheckModel,
  selectProvider,
  __setVertexCredentialsForTests,
  type VertexCredentials,
} from "./llm-client.js";

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

test("callLlm: no AWS_BEARER_TOKEN_BEDROCK (and no other provider) throws before any network call", async () => {
  let called = false;
  await withEnv({}, () =>
    withMockFetch(
      (async () => {
        called = true;
        throw new Error("should not be called");
      }) as typeof fetch,
      async () => {
        await assert.rejects(() => callLlm("s", "u", { model: "m", region: "us-east-1" }), /no LLM provider configured/);
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
// Multi-provider dispatch (design a4937c29, PR #11 review follow-up): auto-
// detect among Bedrock / Vertex / OpenRouter / Bifrost, per-provider models.
// ---------------------------------------------------------------------------

const PROVIDER_ENV_KEYS = [
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GCLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
  "TWING_BIFROST_BASE_URL",
  "TWING_BIFROST_API_KEY",
  "TWING_BEDROCK_EXTRACT_MODEL",
  "TWING_BEDROCK_SEMANTIC_CHECK_MODEL",
  "TWING_VERTEX_EXTRACT_MODEL",
  "TWING_VERTEX_SEMANTIC_CHECK_MODEL",
  "TWING_OPENROUTER_EXTRACT_MODEL",
  "TWING_OPENROUTER_SEMANTIC_CHECK_MODEL",
  "TWING_BIFROST_EXTRACT_MODEL",
  "TWING_BIFROST_SEMANTIC_CHECK_MODEL",
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

/** Swaps in a fake Vertex credential source for the body of `run`. */
function withVertexCreds<T>(creds: VertexCredentials, run: () => Promise<T>): Promise<T> {
  __setVertexCredentialsForTests(creds);
  return run().finally(() => __setVertexCredentialsForTests(undefined));
}

test("selectProvider: precedence is AWS -> GCP -> OpenRouter -> Bifrost", async () => {
  await withEnv(
    { AWS_BEARER_TOKEN_BEDROCK: "t", GOOGLE_APPLICATION_CREDENTIALS: "/sa.json", OPENROUTER_API_KEY: "k", TWING_BIFROST_BASE_URL: "http://x" },
    async () => assert.equal(selectProvider(), "bedrock"),
  );
  await withEnv(
    { GOOGLE_APPLICATION_CREDENTIALS: "/sa.json", OPENROUTER_API_KEY: "k", TWING_BIFROST_BASE_URL: "http://x" },
    async () => assert.equal(selectProvider(), "vertex"),
  );
  await withEnv({ OPENROUTER_API_KEY: "k", TWING_BIFROST_BASE_URL: "http://x" }, async () =>
    assert.equal(selectProvider(), "openrouter"),
  );
  await withEnv({ TWING_BIFROST_BASE_URL: "http://x" }, async () => assert.equal(selectProvider(), "bifrost"));
});

test("selectProvider: throws when no provider credential/base-URL is set (no default)", async () => {
  await withEnv({}, async () => {
    assert.throws(() => selectProvider(), /no LLM provider configured/);
  });
});

test("callLlm: with no provider configured, throws before any network call (caller fails soft)", async () => {
  let called = false;
  await withEnv({}, () =>
    withMockFetch(
      (async () => {
        called = true;
        throw new Error("should not be called");
      }) as typeof fetch,
      async () => {
        await assert.rejects(() => callLlm("s", "u", { model: "m" }), /no LLM provider configured/);
      },
    ),
  );
  assert.equal(called, false);
});

test("resolveExtractModel / resolveSemanticCheckModel: per-provider default, overridable per provider", async () => {
  await withEnv({ AWS_BEARER_TOKEN_BEDROCK: "t" }, async () => {
    assert.equal(resolveExtractModel(), "google.gemma-4-31b");
    assert.equal(resolveSemanticCheckModel(), "google.gemma-4-31b");
  });
  await withEnv({ TWING_BIFROST_BASE_URL: "http://x" }, async () => {
    assert.equal(resolveExtractModel(), "openai/gpt-4o-mini");
  });
  await withEnv({ GOOGLE_APPLICATION_CREDENTIALS: "/sa.json" }, async () => {
    assert.equal(resolveExtractModel(), "google/gemini-2.0-flash");
  });
  await withEnv(
    { OPENROUTER_API_KEY: "k", TWING_OPENROUTER_EXTRACT_MODEL: "anthropic/claude-3-5-haiku", TWING_OPENROUTER_SEMANTIC_CHECK_MODEL: "openai/gpt-4o" },
    async () => {
      assert.equal(resolveExtractModel(), "anthropic/claude-3-5-haiku");
      assert.equal(resolveSemanticCheckModel(), "openai/gpt-4o");
    },
  );
  await withEnv({}, async () => {
    assert.throws(() => resolveExtractModel(), /no LLM provider configured/);
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

test("vertex: gets a token + project from google-auth-library, calls the OpenAI-compat endpoint with Bearer", async () => {
  let projectCalls = 0;
  let tokenCalls = 0;
  const creds: VertexCredentials = {
    accessToken: async () => {
      tokenCalls++;
      return "ya29.fake";
    },
    projectId: async () => {
      projectCalls++;
      return "proj-from-adc";
    },
  };

  let aiUrl = "";
  let aiAuth = "";
  let aiBody: unknown;
  await withEnv({ GOOGLE_APPLICATION_CREDENTIALS: "/sa.json" }, () =>
    withVertexCreds(creds, () =>
      withMockFetch(
        (async (url: string, init?: RequestInit) => {
          aiUrl = url;
          aiAuth = (init!.headers as Record<string, string>).authorization;
          aiBody = JSON.parse(init!.body as string);
          return new Response(JSON.stringify({ choices: [{ message: { content: "  hi from vertex  " } }] }), { status: 200 });
        }) as typeof fetch,
        async () => {
          const text = await callLlm("s", "u", { model: "google/gemini-2.0-flash" });
          assert.equal(text, "hi from vertex");
        },
      ),
    ),
  );

  // No GOOGLE_CLOUD_LOCATION -> defaults to "global" -> location-less host,
  // path still carries locations/global.
  assert.equal(
    aiUrl,
    "https://aiplatform.googleapis.com/v1/projects/proj-from-adc/locations/global/endpoints/openapi/chat/completions",
  );
  assert.equal(aiAuth, "Bearer ya29.fake");
  assert.deepEqual((aiBody as { model: string }).model, "google/gemini-2.0-flash");
  assert.equal(tokenCalls, 1);
  assert.equal(projectCalls, 1);
});

test("vertex: an explicit GOOGLE_CLOUD_LOCATION=global also uses the location-less host", async () => {
  const creds: VertexCredentials = { accessToken: async () => "ya29.fake", projectId: async () => "p" };
  let aiUrl = "";
  await withEnv({ GOOGLE_APPLICATION_CREDENTIALS: "/sa.json", GOOGLE_CLOUD_PROJECT: "proj", GOOGLE_CLOUD_LOCATION: "global" }, () =>
    withVertexCreds(creds, () =>
      withMockFetch(
        (async (url: string) => {
          aiUrl = url;
          return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
        }) as typeof fetch,
        () => callLlm("s", "u", { model: "google/gemini-2.0-flash" }),
      ),
    ),
  );
  assert.equal(
    aiUrl,
    "https://aiplatform.googleapis.com/v1/projects/proj/locations/global/endpoints/openapi/chat/completions",
  );
});

test("vertex: GOOGLE_CLOUD_PROJECT / GOOGLE_CLOUD_LOCATION override the auto-resolved project + region", async () => {
  let projectCalls = 0;
  const creds: VertexCredentials = {
    accessToken: async () => "ya29.fake",
    projectId: async () => {
      projectCalls++;
      return "should-not-be-used";
    },
  };
  let aiUrl = "";
  await withEnv(
    { GOOGLE_APPLICATION_CREDENTIALS: "/sa.json", GOOGLE_CLOUD_PROJECT: "explicit-proj", GOOGLE_CLOUD_LOCATION: "europe-west4" },
    () =>
      withVertexCreds(creds, () =>
        withMockFetch(
          (async (url: string) => {
            aiUrl = url;
            return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
          }) as typeof fetch,
          () => callLlm("s", "u", { model: "google/gemini-2.0-flash" }),
        ),
      ),
  );
  assert.equal(
    aiUrl,
    "https://europe-west4-aiplatform.googleapis.com/v1/projects/explicit-proj/locations/europe-west4/endpoints/openapi/chat/completions",
  );
  assert.equal(projectCalls, 0, "explicit GOOGLE_CLOUD_PROJECT should short-circuit the credential lookup");
});

test("vertex: a credential error propagates (caller's retry loop is responsible for failing soft)", async () => {
  const creds: VertexCredentials = {
    accessToken: async () => {
      throw new Error("google-auth-library returned no access token");
    },
    projectId: async () => "proj",
  };
  await withEnv({ GOOGLE_APPLICATION_CREDENTIALS: "/sa.json" }, () =>
    withVertexCreds(creds, () =>
      withMockFetch(
        (async () => new Response("{}", { status: 200 })) as typeof fetch,
        async () => {
          await assert.rejects(() => callLlm("s", "u", { model: "m" }), /no access token/);
        },
      ),
    ),
  );
});

test("describeLlmProvider: null when nothing is configured, otherwise the detected provider", async () => {
  await withEnv({}, async () => {
    const d = describeLlmProvider();
    assert.equal(d.provider, null);
    assert.equal(d.ready, false);
  });
  await withEnv({ TWING_BIFROST_BASE_URL: "http://localhost:8080", TWING_BIFROST_API_KEY: "sk-bf-x" }, async () => {
    const d = describeLlmProvider();
    assert.equal(d.provider, "bifrost");
    assert.equal(d.ready, true);
    assert.match(d.summary, /virtual key/);
  });
  await withEnv({ GOOGLE_APPLICATION_CREDENTIALS: "/sa.json" }, async () => {
    const d = describeLlmProvider();
    assert.equal(d.provider, "vertex");
    assert.equal(d.ready, true);
  });
});
