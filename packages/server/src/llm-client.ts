/**
 * "Call a model with a chat message list, get back raw text" -- pulled out
 * of `design-extract.ts` (statefulness/eval work, 2026-08) so it can also
 * serve `design-semantic-check.ts`'s async comparator, which needs real
 * few-shot conversation turns (system + example user/assistant pairs + the
 * real user turn), not just a single system+user exchange. This module owns
 * the model call only; retry policy, parsing, and fail-soft behavior stay
 * in whichever caller has an opinion about them -- this file doesn't catch
 * its own errors, it throws on failure.
 *
 * Four provider paths, all speaking the same OpenAI chat-completions
 * request/response shape so `parseChatCompletion` is shared and the caller
 * (`callLlmMessages`) only picks a transport (OpenRouter was a fifth once,
 * removed 2026-08-17, then folded back in here 2026-08-30 alongside Bifrost
 * and Vertex -- see design a4937c29):
 *
 *   - bedrock     `bedrock-mantle`, a plain Bearer-token HTTPS shim, *not*
 *                 the Bedrock Runtime `Converse` API (that SDK path doesn't
 *                 work for the models on the account we have credits on:
 *                 `google.gemma-4-31b` isn't in `ListFoundationModels` at
 *                 all, `zai.glm-5` returns "Operation not allowed" on
 *                 `ConverseCommand` -- both are only reachable through this
 *                 shim, confirmed live 2026-08). Per-model path differs
 *                 (`gemma-4-31b` -> `/openai/v1`, everything else -> `/v1`),
 *                 same pattern as TwingMail's own
 *                 `packages/core/src/lib/ai.ts` `BEDROCK_MODEL_MAP`.
 *   - vertex      GCP Vertex AI's OpenAI-compatible endpoint. Auth is a
 *                 short-lived OAuth token from `google-auth-library`'s
 *                 `GoogleAuth` (picks up `GOOGLE_APPLICATION_CREDENTIALS` /
 *                 ADC / the GCE metadata server, and handles token refresh
 *                 and caching itself) -- the hand-rolled RS256-JWT bearer
 *                 grant this used to do with `node:crypto` was more surface
 *                 area than it was worth (PR #11 review).
 *   - openrouter  `https://openrouter.ai/api/v1/chat/completions`; `model`
 *                 is a `provider/model` string.
 *   - bifrost     A self-hosted LLM gateway (https://docs.getbifrost.ai).
 *                 OpenAI-shaped `POST {base}/v1/chat/completions`; `model`
 *                 is a `provider/model` string (e.g. `openai/gpt-4o-mini`).
 *
 * Provider selection is ambient -- there is no caller-supplied `provider`
 * field and no `TWING_LLM_PROVIDER` override, same way credentials are read
 * from `process.env` rather than threaded through `LlmCallOptions`.
 * `selectProvider` picks the first provider whose credential/base-URL var
 * is present, in precedence order **AWS -> GCP -> OpenRouter -> Bifrost**,
 * and **throws** if none is set (there is no default). The throw propagates
 * to the caller, whose retry loop (`design-extract.ts` /
 * `design-semantic-check.ts`) catches it and fails soft -- extraction to
 * empty fields ("clean"), the comparator to "no conflict". So a server with
 * no LLM provider configured still runs; it just never blocks on a
 * plan-text check. `main.ts` logs one advisory line at startup.
 *
 * Model is chosen per provider, not globally (PR #11 review: the same model
 * has different ids on different providers, so a single top-level default
 * can't survive a provider switch). `resolveExtractModel` /
 * `resolveSemanticCheckModel` read `TWING_<PROVIDER>_EXTRACT_MODEL` /
 * `TWING_<PROVIDER>_SEMANTIC_CHECK_MODEL` and fall back to a
 * provider-appropriate default (see `PROVIDER_MODELS`).
 *
 * Env, by provider:
 *   bedrock     AWS_BEARER_TOKEN_BEDROCK, AWS_REGION / AWS_DEFAULT_REGION,
 *               TWING_BEDROCK_EXTRACT_MODEL / TWING_BEDROCK_SEMANTIC_CHECK_MODEL
 *   vertex      GOOGLE_APPLICATION_CREDENTIALS (service-account JSON path;
 *               also what selection keys off), GOOGLE_CLOUD_PROJECT /
 *               GCLOUD_PROJECT (or resolved from the credentials),
 *               GOOGLE_CLOUD_LOCATION (optional, default us-central1),
 *               TWING_VERTEX_EXTRACT_MODEL / TWING_VERTEX_SEMANTIC_CHECK_MODEL
 *   openrouter  OPENROUTER_API_KEY, OPENROUTER_BASE_URL (optional),
 *               TWING_OPENROUTER_EXTRACT_MODEL / TWING_OPENROUTER_SEMANTIC_CHECK_MODEL
 *   bifrost     TWING_BIFROST_BASE_URL, TWING_BIFROST_API_KEY (optional;
 *               unset -> no auth header, `sk-bf-` prefix -> `x-bf-vk`
 *               header, anything else -> `Authorization: Bearer <key>`),
 *               TWING_BIFROST_EXTRACT_MODEL / TWING_BIFROST_SEMANTIC_CHECK_MODEL
 */

import { GoogleAuth } from "google-auth-library";

// gemma-4-31b is only reachable via bedrock-mantle's OpenAI-compat route,
// not its plain-Bedrock-model route -- everything else (glm-5, and per
// TwingMail's own map, gemma-3-*) uses plain "/v1". Confirmed live.
const BEDROCK_MANTLE_PATH: Record<string, "/v1" | "/openai/v1"> = {
  "google.gemma-4-31b": "/openai/v1",
};

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmCallOptions {
  /** Model id, in whatever form the selected provider expects -- a
   * Bedrock model id (`google.gemma-4-31b`), or a `provider/model` string
   * for Bifrost/OpenRouter/Vertex (`openai/gpt-4o-mini`,
   * `google/gemini-2.0-flash`). Callers normally pass the result of
   * `resolveExtractModel()` / `resolveSemanticCheckModel()`. */
  model: string;
  /** Bedrock only: omit to fall back to AWS_REGION/AWS_DEFAULT_REGION. */
  region?: string;
}

export type LlmProvider = "bedrock" | "vertex" | "openrouter" | "bifrost";

/**
 * Which provider a call will use right now, given the environment: the
 * first one whose credential/base-URL var is present, in precedence order
 * AWS -> GCP -> OpenRouter -> Bifrost. **Throws** if none is set -- there is
 * no default provider. The throw is expected to reach a caller that fails
 * soft (see this file's header comment).
 */
export function selectProvider(): LlmProvider {
  if (process.env.AWS_BEARER_TOKEN_BEDROCK) return "bedrock";
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return "vertex";
  if (process.env.OPENROUTER_API_KEY) return "openrouter";
  if (process.env.TWING_BIFROST_BASE_URL) return "bifrost";
  throw new Error(
    "no LLM provider configured -- set one of AWS_BEARER_TOKEN_BEDROCK, GOOGLE_APPLICATION_CREDENTIALS, OPENROUTER_API_KEY, or TWING_BIFROST_BASE_URL",
  );
}

interface ProviderModels {
  extractEnv: string;
  extractDefault: string;
  semanticEnv: string;
  semanticDefault: string;
}

const PROVIDER_MODELS: Record<LlmProvider, ProviderModels> = {
  bedrock: {
    extractEnv: "TWING_BEDROCK_EXTRACT_MODEL",
    extractDefault: "google.gemma-4-31b",
    semanticEnv: "TWING_BEDROCK_SEMANTIC_CHECK_MODEL",
    semanticDefault: "google.gemma-4-31b",
  },
  vertex: {
    extractEnv: "TWING_VERTEX_EXTRACT_MODEL",
    extractDefault: "google/gemini-2.0-flash",
    semanticEnv: "TWING_VERTEX_SEMANTIC_CHECK_MODEL",
    semanticDefault: "google/gemini-2.0-flash",
  },
  openrouter: {
    extractEnv: "TWING_OPENROUTER_EXTRACT_MODEL",
    extractDefault: "openai/gpt-4o-mini",
    semanticEnv: "TWING_OPENROUTER_SEMANTIC_CHECK_MODEL",
    semanticDefault: "openai/gpt-4o-mini",
  },
  bifrost: {
    extractEnv: "TWING_BIFROST_EXTRACT_MODEL",
    extractDefault: "openai/gpt-4o-mini",
    semanticEnv: "TWING_BIFROST_SEMANTIC_CHECK_MODEL",
    semanticDefault: "openai/gpt-4o-mini",
  },
};

/** The extraction model for the active provider: `TWING_<PROVIDER>_EXTRACT_MODEL`
 * if set, else the provider's default. Throws (via `selectProvider`) when no
 * provider is configured. */
export function resolveExtractModel(): string {
  const m = PROVIDER_MODELS[selectProvider()];
  return process.env[m.extractEnv]?.trim() || m.extractDefault;
}

/** The semantic-conflict-check model for the active provider:
 * `TWING_<PROVIDER>_SEMANTIC_CHECK_MODEL` if set, else the provider's default. */
export function resolveSemanticCheckModel(): string {
  const m = PROVIDER_MODELS[selectProvider()];
  return process.env[m.semanticEnv]?.trim() || m.semanticDefault;
}

/** One-line, secret-free description of the active provider config, for
 * main.ts's startup log. `provider` is null when none is configured. `ready`
 * is a best-effort "the obvious required vars are present" check -- not a
 * live call. */
export function describeLlmProvider(): { provider: LlmProvider | null; ready: boolean; summary: string } {
  let provider: LlmProvider;
  try {
    provider = selectProvider();
  } catch {
    return {
      provider: null,
      ready: false,
      summary:
        "no provider detected (need AWS_BEARER_TOKEN_BEDROCK / GOOGLE_APPLICATION_CREDENTIALS / OPENROUTER_API_KEY / TWING_BIFROST_BASE_URL)",
    };
  }
  switch (provider) {
    case "bedrock": {
      const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
      return {
        provider,
        ready: Boolean(process.env.AWS_BEARER_TOKEN_BEDROCK && region),
        summary: `Bedrock (bedrock-mantle)${region ? `, region ${region}` : ", region unset"}`,
      };
    }
    case "vertex": {
      const project = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT;
      const location = process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1";
      return {
        provider,
        ready: Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS),
        summary: `Vertex AI (project ${project ?? "from credentials"}, location ${location})`,
      };
    }
    case "openrouter":
      return {
        provider,
        ready: Boolean(process.env.OPENROUTER_API_KEY),
        summary: `OpenRouter at ${process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1"}`,
      };
    case "bifrost": {
      const base = process.env.TWING_BIFROST_BASE_URL;
      const key = process.env.TWING_BIFROST_API_KEY;
      const auth = !key ? "no auth" : key.startsWith("sk-bf-") ? "virtual key" : "bearer token";
      return { provider, ready: Boolean(base), summary: `Bifrost gateway at ${base ?? "(TWING_BIFROST_BASE_URL unset)"} (${auth})` };
    }
  }
}

/** Shared for all four transports: they all return
 * `{ choices: [{ message: { content } }] }` on success and
 * `{ error: { message } }` on failure. */
async function parseChatCompletion(res: Response, label: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as {
    choices?: { message?: { content?: string } }[];
    error?: { message?: string };
  };
  if (!res.ok) {
    throw new Error(`${label} request failed (${res.status}): ${body.error?.message ?? JSON.stringify(body)}`);
  }
  return body.choices?.[0]?.message?.content?.trim() ?? "";
}

async function callBedrock(messages: ChatMessage[], options: LlmCallOptions): Promise<string> {
  const region = options.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (!region) {
    throw new Error("Bedrock request failed: no region -- set AWS_REGION/AWS_DEFAULT_REGION or pass options.region");
  }
  const token = process.env.AWS_BEARER_TOKEN_BEDROCK;
  if (!token) {
    throw new Error("Bedrock request failed: no credentials -- set AWS_BEARER_TOKEN_BEDROCK");
  }
  const path = BEDROCK_MANTLE_PATH[options.model] ?? "/v1";

  const res = await fetch(`https://bedrock-mantle.${region}.api.aws${path}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ model: options.model, messages }),
  });
  return parseChatCompletion(res, "Bedrock");
}

/** The bits of `google-auth-library` `callVertex` needs. Behind an
 * interface only so `llm-client.test.ts` can swap in a fake via
 * `__setVertexCredentialsForTests` instead of standing up real GCP
 * credentials -- production always uses `googleAuthCredentials()`. */
export interface VertexCredentials {
  accessToken(): Promise<string>;
  projectId(): Promise<string | undefined>;
}

let googleAuth: GoogleAuth | undefined;
let vertexCredentialsOverride: VertexCredentials | undefined;

/** Test-only: swap the credential source (pass `undefined` to restore). */
export function __setVertexCredentialsForTests(v: VertexCredentials | undefined): void {
  vertexCredentialsOverride = v;
}

/** `google-auth-library` loads `GOOGLE_APPLICATION_CREDENTIALS` / ADC /
 * metadata-server credentials and caches + refreshes the token itself, so
 * there is nothing to cache here. */
function googleAuthCredentials(): VertexCredentials {
  googleAuth ??= new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });
  const auth = googleAuth;
  return {
    async accessToken() {
      const token = await auth.getAccessToken();
      if (!token) {
        throw new Error(
          "Vertex request failed: google-auth-library returned no access token -- check GOOGLE_APPLICATION_CREDENTIALS / application default credentials",
        );
      }
      return token;
    },
    projectId: () => auth.getProjectId().catch(() => undefined),
  };
}

async function callVertex(messages: ChatMessage[], options: LlmCallOptions): Promise<string> {
  const creds = vertexCredentialsOverride ?? googleAuthCredentials();
  const project =
    process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT ?? (await creds.projectId());
  if (!project) {
    throw new Error("Vertex request failed: no project -- set GOOGLE_CLOUD_PROJECT (or use credentials that carry one)");
  }
  const location = process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1";
  const token = await creds.accessToken();

  const res = await fetch(
    `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/endpoints/openapi/chat/completions`,
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: options.model, messages }),
    },
  );
  return parseChatCompletion(res, "Vertex");
}

async function callOpenRouter(messages: ChatMessage[], options: LlmCallOptions): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new Error("OpenRouter request failed: no credentials -- set OPENROUTER_API_KEY");
  }
  const base = (process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/+$/, "");

  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: options.model, messages }),
  });
  return parseChatCompletion(res, "OpenRouter");
}

/** `sk-bf-...` -> Bifrost virtual key header; any other value -> bearer;
 * unset -> no auth header at all (a keyless localhost gateway). */
function bifrostAuthHeaders(key: string | undefined): Record<string, string> {
  if (!key) return {};
  if (key.startsWith("sk-bf-")) return { "x-bf-vk": key };
  return { authorization: `Bearer ${key}` };
}

async function callBifrost(messages: ChatMessage[], options: LlmCallOptions): Promise<string> {
  const rawBase = process.env.TWING_BIFROST_BASE_URL;
  if (!rawBase) {
    throw new Error("Bifrost request failed: no gateway URL -- set TWING_BIFROST_BASE_URL");
  }
  const base = rawBase.replace(/\/+$/, "");

  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bifrostAuthHeaders(process.env.TWING_BIFROST_API_KEY) },
    body: JSON.stringify({ model: options.model, messages }),
  });
  return parseChatCompletion(res, "Bifrost");
}

/** The general form: a full message list (system + any few-shot user/
 * assistant example turns + the real user turn). `callLlm` below is a thin
 * convenience wrapper for the common single-system-message-plus-user-turn
 * case. Provider is chosen ambiently -- see `selectProvider` (throws when
 * none is configured). */
export async function callLlmMessages(messages: ChatMessage[], options: LlmCallOptions): Promise<string> {
  switch (selectProvider()) {
    case "vertex":
      return callVertex(messages, options);
    case "openrouter":
      return callOpenRouter(messages, options);
    case "bifrost":
      return callBifrost(messages, options);
    case "bedrock":
      return callBedrock(messages, options);
  }
}

export async function callLlm(systemPrompt: string, userPrompt: string, options: LlmCallOptions): Promise<string> {
  return callLlmMessages(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    options,
  );
}
