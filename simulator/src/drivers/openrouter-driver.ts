import * as fs from "node:fs";
import type { Driver, DriverContext } from "./driver.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 500;

interface OpenRouterResponse {
  choices?: { message?: { content?: string } }[];
  error?: { message?: string };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Plays the human developer's side: given the agent's latest report,
 * decide whether the goal looks done, or what to tell it next. OpenAI-
 * compatible chat completions -- works against OpenRouter's endpoint here,
 * but the same shape as Ollama/LM Studio/vLLM if the base URL ever needs
 * to change.
 */
export class OpenRouterDriver implements Driver {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
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

    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(OPENROUTER_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({ model: this.model, messages }),
        });

        const body = (await res.json()) as OpenRouterResponse;
        if (!res.ok) {
          throw new Error(`OpenRouter request failed (${res.status}): ${body.error?.message ?? JSON.stringify(body)}`);
        }

        const text = body.choices?.[0]?.message?.content?.trim() ?? "";
        return !text || /^done\b/i.test(text) ? null : text;
      } catch (err) {
        // Network-level aborts (undici "terminated" and friends) surface as
        // a thrown error from fetch() itself, not an HTTP status -- worth
        // one or two retries before giving up, same as any flaky API call.
        lastError = err;
        if (attempt < MAX_ATTEMPTS) {
          console.error(`[${ctx.sessionLabel}] OpenRouter call failed (attempt ${attempt}/${MAX_ATTEMPTS}), retrying: ${err instanceof Error ? err.message : err}`);
          await sleep(RETRY_BASE_MS * attempt);
        }
      }
    }
    throw lastError;
  }
}

export function readOpenRouterKey(filePath: string): string {
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) throw new Error(`OpenRouter key file at ${filePath} is empty`);
  return raw;
}
