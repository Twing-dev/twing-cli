import { test } from "node:test";
import assert from "node:assert/strict";
import { answerDesignChat, groundingBudgetFor } from "./design-comment-answer.js";

// The reviewer chat's answerer. The comment answerer that used to share this
// file was removed on 2026-09-27 (comments are answered by people now), and
// its tests with it; the budgeting guarantees below are the chat's own.

function withMockFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

function withBedrockEnv<T>(run: () => Promise<T>): Promise<T> {
  const originalToken = process.env.AWS_BEARER_TOKEN_BEDROCK;
  const originalRegion = process.env.AWS_REGION;
  process.env.AWS_BEARER_TOKEN_BEDROCK = "test-token";
  process.env.AWS_REGION = "us-east-1";
  return run().finally(() => {
    if (originalToken === undefined) delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    else process.env.AWS_BEARER_TOKEN_BEDROCK = originalToken;
    if (originalRegion === undefined) delete process.env.AWS_REGION;
    else process.env.AWS_REGION = originalRegion;
  });
}

function llmResponse(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

/** Runs one chat turn and returns what was actually sent to the model --
 * captured off the wire so assertions are about the real request, not about
 * one part of it. */
async function sentPrompt(grounding: string, history: { role: "reviewer" | "agent"; message: string }[]): Promise<string> {
  let sent = "";
  await withBedrockEnv(() =>
    withMockFetch(async (_input, init) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { messages?: { content: string }[] };
      sent = (body.messages ?? []).map((m) => m.content).join("\n");
      return llmResponse("an answer");
    }, () => answerDesignChat(grounding, history, { model: "test-model" })),
  );
  return sent;
}

// -- one budget across the whole prompt (found in review) -------------------
//
// Grounding took the whole budget and the system prompt, history and question
// were added on top, so the number every part respected individually was one
// the total never did: 96,057 characters measured for a chat against a stated
// 48,000.

test("answerDesignChat: the whole request fits the budget", async () => {
  const grounding = "G".repeat(groundingBudgetFor("why?", 200_000));
  const history = Array.from({ length: 200 }, (_, i) => ({
    role: (i % 2 === 0 ? "agent" : "reviewer") as "agent" | "reviewer",
    message: `msg${i} ${"x".repeat(5_000)}`,
  }));
  const sent = await sentPrompt(grounding, history);
  assert.ok(sent.length <= 48_000, `whole prompt was ${sent.length} chars`);
});

test("groundingBudgetFor: leaves more room for grounding when the question and thread are small", () => {
  const roomy = groundingBudgetFor("why?", 0);
  const cramped = groundingBudgetFor("x".repeat(8_000), 100_000);
  assert.ok(roomy > cramped);
  assert.ok(cramped >= 8_000, "and never starves the model of the design itself");
});

test("groundingBudgetFor: an enormous question cannot drive the grounding budget negative", () => {
  assert.ok(groundingBudgetFor("x".repeat(1_000_000), 1_000_000) >= 8_000);
});

// -- the question is never what gets cut (found in review, three times) -----

test("answerDesignChat: the question reaches the model even when everything else overruns", async () => {
  const history = [
    ...Array.from({ length: 300 }, (_, i) => ({ role: (i % 2 === 0 ? "agent" : "reviewer") as "agent" | "reviewer", message: `m${i} ${"x".repeat(4_000)}` })),
    { role: "reviewer" as const, message: "the question that must not vanish" },
  ];
  const sent = await sentPrompt("G".repeat(48_000), history);
  assert.match(sent, /the question that must not vanish/);
  assert.match(sent, /earlier context truncated/, "and the cut is marked rather than silent");
  assert.ok(sent.length <= 48_000, `whole request was ${sent.length} chars`);
});

test("answerDesignChat: a prompt that already fits is left alone, with no cut marker", async () => {
  const sent = await sentPrompt("DESIGN SUMMARY:\nAdd a retry budget to the HTTP client", [{ role: "reviewer", message: "why 30s and not 10s?" }]);
  assert.doesNotMatch(sent, /earlier context truncated/);
  assert.match(sent, /THE REVIEWER IS NOW ASKING:\nwhy 30s and not 10s\?/);
});

test("answerDesignChat: an unreachable model answers with a sentence saying so, not an exception", async () => {
  const answer = await withBedrockEnv(() => withMockFetch(async () => new Response("boom", { status: 500 }), () => answerDesignChat("G", [{ role: "reviewer", message: "why?" }], { model: "test-model" })));
  assert.match(answer, /could not reach a model/);
});
