import type { Driver, DriverContext } from "./driver.js";

// Only reachable via bedrock-mantle's OpenAI-compat route, not its plain-
// Bedrock-model route -- see packages/server/src/llm-client.ts's header
// comment for the full story (confirmed live, 2026-08). Duplicated here
// rather than imported: this Bedrock call is small, and @twing/server's
// llm-client.ts isn't part of its public index.ts surface -- the same
// "duplicated rather than imported" call design-extract.ts's own header
// comment already makes for this exact file.
const BEDROCK_MANTLE_PATH: Record<string, "/v1" | "/openai/v1"> = {
  "google.gemma-4-31b": "/openai/v1",
};

const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 500;

interface BedrockResponse {
  choices?: { message?: { content?: string } }[];
  error?: { message?: string };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Plays the human developer's side: given the agent's latest report,
 * decide whether the goal looks done, or what to tell it next.
 * OpenRouter's replacement (removed 2026-08-17 -- the org standardized on
 * AWS Bedrock and doesn't want a second LLM vendor anywhere in this repo,
 * simulator included). Credentials are read ambiently from the
 * environment (AWS_BEARER_TOKEN_BEDROCK, region falling back to
 * AWS_REGION/AWS_DEFAULT_REGION) -- same as packages/server's own Bedrock
 * calls, no key file to plumb through CLI flags anymore.
 */
export class BedrockDriver implements Driver {
  constructor(
    private readonly model: string,
    private readonly region?: string,
  ) {}

  async nextMessage(ctx: DriverContext): Promise<string | null> {
    if (ctx.turnNumber >= ctx.maxTurns) return null;

    const systemPrompt = [
      `You are directing an AI coding agent (session ${ctx.sessionLabel}) toward this goal:`,
      `"${ctx.goal}"`,
      "",
      "The agent just reported back after doing some work. If the goal looks complete, reply with exactly DONE and nothing else.",
      "Otherwise reply with one short, concrete next instruction to move it closer to the goal -- no explanation, just the instruction.",
    ].join("\n");

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Agent's report (turn ${ctx.turnNumber}/${ctx.maxTurns}):\n${ctx.latestAgentResult}` },
    ];

    const region = this.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
    if (!region) {
      throw new Error("Bedrock request failed: no region -- set AWS_REGION/AWS_DEFAULT_REGION or pass --bedrock-region");
    }
    const token = process.env.AWS_BEARER_TOKEN_BEDROCK;
    if (!token) {
      throw new Error("Bedrock request failed: no credentials -- set AWS_BEARER_TOKEN_BEDROCK");
    }
    const path = BEDROCK_MANTLE_PATH[this.model] ?? "/v1";

    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(`https://bedrock-mantle.${region}.api.aws${path}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ model: this.model, messages }),
        });

        const body = (await res.json()) as BedrockResponse;
        if (!res.ok) {
          throw new Error(`Bedrock request failed (${res.status}): ${body.error?.message ?? JSON.stringify(body)}`);
        }

        const text = body.choices?.[0]?.message?.content?.trim() ?? "";
        return !text || /^done\b/i.test(text) ? null : text;
      } catch (err) {
        // Network-level aborts (undici "terminated" and friends) surface as
        // a thrown error from fetch() itself, not an HTTP status -- worth
        // one or two retries before giving up, same as any flaky API call.
        lastError = err;
        if (attempt < MAX_ATTEMPTS) {
          console.error(`[${ctx.sessionLabel}] Bedrock call failed (attempt ${attempt}/${MAX_ATTEMPTS}), retrying: ${err instanceof Error ? err.message : err}`);
          await sleep(RETRY_BASE_MS * attempt);
        }
      }
    }
    throw lastError;
  }
}
