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
 *   - bedrock     `bedrock-mantle`, the default. Plain Bearer-token HTTPS
 *                 shim, *not* the Bedrock Runtime `Converse` API (that SDK
 *                 path doesn't work for the models on the account we have
 *                 credits on: `google.gemma-4-31b` isn't in
 *                 `ListFoundationModels` at all, `zai.glm-5` returns
 *                 "Operation not allowed" on `ConverseCommand` -- both are
 *                 only reachable through this shim, confirmed live 2026-08).
 *                 Per-model path differs (`gemma-4-31b` -> `/openai/v1`,
 *                 everything else -> `/v1`), same pattern as TwingMail's own
 *                 `packages/core/src/lib/ai.ts` `BEDROCK_MODEL_MAP`.
 *   - bifrost     A self-hosted LLM gateway (https://docs.getbifrost.ai).
 *                 OpenAI-shaped `POST {base}/v1/chat/completions`; `model`
 *                 is a `provider/model` string (e.g. `openai/gpt-4o-mini`).
 *   - openrouter  `https://openrouter.ai/api/v1/chat/completions`; `model`
 *                 is a `provider/model` string.
 *   - vertex      GCP Vertex AI's OpenAI-compatible endpoint. Auth is a
 *                 short-lived OAuth token minted from a service-account JSON
 *                 via an RS256 JWT bearer grant -- done here with `node:crypto`
 *                 rather than pulling in `google-auth-library`, matching this
 *                 module's no-SDK stance (same reason `callBedrock` hand-rolls
 *                 its Bearer call instead of using the AWS SDK). Token cached
 *                 in-process until ~1min before expiry.
 *
 * Provider selection is ambient -- there is no caller-supplied `provider`
 * field, same way credentials are read from `process.env` rather than
 * threaded through `LlmCallOptions`. `TWING_LLM_PROVIDER` forces the choice
 * when set to a known value; otherwise `selectProvider` auto-detects from
 * which credential/base-URL vars are present, Bedrock winning ties (the
 * assumption is only one provider's config is present at a time and Bedrock
 * is the default). A misconfigured deployment finds out when the real call
 * throws and the caller falls soft -- there is no separate presence
 * precheck here (main.ts logs one advisory line at startup, that's all).
 *
 * Env, by provider:
 *   bedrock     AWS_BEARER_TOKEN_BEDROCK, AWS_REGION / AWS_DEFAULT_REGION
 *   bifrost     TWING_BIFROST_BASE_URL, TWING_BIFROST_API_KEY (optional;
 *               unset -> no auth header, `sk-bf-` prefix -> `x-bf-vk`
 *               header, anything else -> `Authorization: Bearer <key>`)
 *   openrouter  OPENROUTER_API_KEY, OPENROUTER_BASE_URL (optional)
 *   vertex      GOOGLE_APPLICATION_CREDENTIALS (service-account JSON path),
 *               GOOGLE_CLOUD_PROJECT / GCLOUD_PROJECT,
 *               GOOGLE_CLOUD_LOCATION (optional, default us-central1)
 */

import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";

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
   * `google/gemini-2.0-flash`). */
  model: string;
  /** Bedrock only: omit to fall back to AWS_REGION/AWS_DEFAULT_REGION. */
  region?: string;
}

export type LlmProvider = "bedrock" | "bifrost" | "openrouter" | "vertex";

const KNOWN_PROVIDERS: readonly LlmProvider[] = ["bedrock", "bifrost", "openrouter", "vertex"];

/**
 * Which provider a call will use right now, given the environment. An
 * explicit `TWING_LLM_PROVIDER` wins; otherwise the first provider whose
 * config is present, in precedence order, with Bedrock as the final
 * fallback (so a fully unconfigured server still throws "no credentials"
 * from `callBedrock` and the caller fails soft, unchanged behavior).
 */
export function selectProvider(): LlmProvider {
  const explicit = process.env.TWING_LLM_PROVIDER?.trim().toLowerCase();
  if (explicit && (KNOWN_PROVIDERS as readonly string[]).includes(explicit)) {
    return explicit as LlmProvider;
  }
  if (process.env.AWS_BEARER_TOKEN_BEDROCK) return "bedrock";
  if (process.env.TWING_BIFROST_BASE_URL) return "bifrost";
  if (process.env.OPENROUTER_API_KEY) return "openrouter";
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return "vertex";
  return "bedrock";
}

/** One-line, secret-free description of the active provider config, for
 * main.ts's startup log. `ready` is a best-effort "the obvious required
 * vars are present" check -- not a live call. */
export function describeLlmProvider(): { provider: LlmProvider; ready: boolean; summary: string } {
  const provider = selectProvider();
  switch (provider) {
    case "bedrock": {
      const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
      const ready = Boolean(process.env.AWS_BEARER_TOKEN_BEDROCK && region);
      return {
        provider,
        ready,
        summary: `Bedrock (bedrock-mantle)${region ? `, region ${region}` : ", region unset"}`,
      };
    }
    case "bifrost": {
      const base = process.env.TWING_BIFROST_BASE_URL;
      const key = process.env.TWING_BIFROST_API_KEY;
      const auth = !key ? "no auth" : key.startsWith("sk-bf-") ? "virtual key" : "bearer token";
      return { provider, ready: Boolean(base), summary: `Bifrost gateway at ${base ?? "(TWING_BIFROST_BASE_URL unset)"} (${auth})` };
    }
    case "openrouter":
      return {
        provider,
        ready: Boolean(process.env.OPENROUTER_API_KEY),
        summary: `OpenRouter at ${process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1"}`,
      };
    case "vertex": {
      const project = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT;
      const location = process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1";
      const ready = Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS && project);
      return {
        provider,
        ready,
        summary: `Vertex AI (project ${project ?? "unset"}, location ${location})`,
      };
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

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

let vertexTokenCache: { key: string; token: string; expiresAt: number } | null = null;

function base64url(input: string | Buffer): string {
  return (typeof input === "string" ? Buffer.from(input) : input).toString("base64url");
}

/** Mint (and cache) a cloud-platform access token from a service-account
 * key via the RS256 JWT bearer grant -- no `google-auth-library`. Cached
 * per `client_email` until ~1min before the token's own expiry. */
async function vertexAccessToken(sa: ServiceAccountKey): Promise<string> {
  const now = Date.now();
  if (vertexTokenCache && vertexTokenCache.key === sa.client_email && vertexTokenCache.expiresAt > now + 60_000) {
    return vertexTokenCache.token;
  }
  const tokenUri = sa.token_uri ?? "https://oauth2.googleapis.com/token";
  const iat = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: tokenUri,
      iat,
      exp: iat + 3600,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const signature = base64url(createSign("RSA-SHA256").update(signingInput).sign(sa.private_key));
  const assertion = `${signingInput}.${signature}`;

  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !body.access_token) {
    throw new Error(
      `Vertex token exchange failed (${res.status}): ${body.error_description ?? body.error ?? JSON.stringify(body)}`,
    );
  }
  vertexTokenCache = {
    key: sa.client_email,
    token: body.access_token,
    expiresAt: now + (body.expires_in ?? 3600) * 1000,
  };
  return body.access_token;
}

async function callVertex(messages: ChatMessage[], options: LlmCallOptions): Promise<string> {
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credPath) {
    throw new Error(
      "Vertex request failed: no credentials -- set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON path",
    );
  }
  const project = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT;
  if (!project) {
    throw new Error("Vertex request failed: no project -- set GOOGLE_CLOUD_PROJECT");
  }
  const location = process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1";

  let sa: ServiceAccountKey;
  try {
    sa = JSON.parse(await readFile(credPath, "utf8")) as ServiceAccountKey;
  } catch (err) {
    throw new Error(
      `Vertex request failed: could not read GOOGLE_APPLICATION_CREDENTIALS (${credPath}): ${err instanceof Error ? err.message : err}`,
    );
  }
  if (!sa.client_email || !sa.private_key) {
    throw new Error("Vertex request failed: GOOGLE_APPLICATION_CREDENTIALS is not a service-account key (no client_email/private_key)");
  }
  const token = await vertexAccessToken(sa);

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

/** The general form: a full message list (system + any few-shot user/
 * assistant example turns + the real user turn). `callLlm` below is a thin
 * convenience wrapper for the common single-system-message-plus-user-turn
 * case. Provider is chosen ambiently -- see `selectProvider`. */
export async function callLlmMessages(messages: ChatMessage[], options: LlmCallOptions): Promise<string> {
  switch (selectProvider()) {
    case "bifrost":
      return callBifrost(messages, options);
    case "openrouter":
      return callOpenRouter(messages, options);
    case "vertex":
      return callVertex(messages, options);
    case "bedrock":
    default:
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
