/**
 * "Call a model with a chat message list, get back raw text" -- pulled out
 * of `design-extract.ts` (statefulness/eval work, 2026-08) so it can also
 * serve `design-semantic-check.ts`'s async comparator, which needs real
 * few-shot conversation turns (system + example user/assistant pairs + the
 * real user turn), not just a single system+user exchange. This module owns
 * the Bedrock call only; retry policy, parsing, and fail-soft behavior stay
 * in whichever caller has an opinion about them -- this file doesn't catch
 * its own errors, it throws on failure.
 *
 * Bedrock-only (OpenRouter support removed 2026-08-17 -- see git history if
 * it's ever needed again; the org standardized on AWS Bedrock and doesn't
 * want a second LLM vendor in the loop at all). Talks to `bedrock-mantle`,
 * an OpenAI-compatible chat-completions shim -- *not* the standard Bedrock
 * Runtime `Converse` API. That SDK path doesn't actually work for the
 * models this system uses on the account we have credits on:
 * `google.gemma-4-31b` isn't in `ListFoundationModels`' catalog at all, and
 * `zai.glm-5` (which is listed) returns "Operation not allowed" on
 * `ConverseCommand` -- both are only reachable through this separate shim,
 * confirmed live (2026-08). Since bedrock-mantle is a plain Bearer-token
 * HTTPS API, there's no AWS SigV4/SDK involved at all.
 * Per-model path differs (`gemma-4-31b` needs `/openai/v1`, everything else
 * defaults to plain `/v1`) -- same pattern as TwingMail's own
 * `packages/core/src/lib/ai.ts` `BEDROCK_MODEL_MAP`, which solves this
 * exact routing problem for its own Gemma usage.
 *
 * Credentials are read ambiently from the environment
 * (`AWS_BEARER_TOKEN_BEDROCK` for auth, `region` falling back to
 * `AWS_REGION`/`AWS_DEFAULT_REGION` when unset) -- there's no explicit
 * caller-supplied secret the way an API key would be.
 */

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
  /** Bedrock model id -- e.g. "google.gemma-4-31b", "zai.glm-5". */
  model: string;
  /** Omit to fall back to AWS_REGION/AWS_DEFAULT_REGION. */
  region?: string;
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

  const body = (await res.json()) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } };
  if (!res.ok) {
    throw new Error(`Bedrock request failed (${res.status}): ${body.error?.message ?? JSON.stringify(body)}`);
  }
  return body.choices?.[0]?.message?.content?.trim() ?? "";
}

/** The general form: a full message list (system + any few-shot user/
 * assistant example turns + the real user turn). `callLlm` below is a thin
 * convenience wrapper for the common single-system-message-plus-user-turn
 * case. */
export async function callLlmMessages(messages: ChatMessage[], options: LlmCallOptions): Promise<string> {
  return callBedrock(messages, options);
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
