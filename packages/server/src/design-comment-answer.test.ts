import { test } from "node:test";
import assert from "node:assert/strict";
import type { DesignStatement, DesignComment, DesignCommentReply } from "@twing/core";
import { answerDesignComment, buildCommentAnswerContext } from "./design-comment-answer.js";

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

function llmResponse(content: unknown) {
  return new Response(JSON.stringify({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] }), { status: 200 });
}

const design: DesignStatement = {
  id: "d1",
  projectId: "p1",
  developerId: "dev@example.com",
  sessionId: "s1",
  status: "open",
  createdAt: 0,
  summary: "Add a retry budget to the HTTP client",
  creates: [],
  touches: ["src/net/retry.ts"],
  dependsOn: [],
  changes: [{ id: "c1", action: "modify", target: "src/net/retry.ts::RetryPolicy.backoff", intent: "cap exponential growth at 30s" }],
  ttlMs: 1000,
  lastActivityAt: 0,
  scopeVersion: 1,
  justifiedConstraintIds: [],
  justifiedOverlaps: [],
  justifiedConflicts: [],
  justifiedSymbolConflicts: [],
};

const comment: DesignComment = {
  id: "cm1",
  projectId: "p1",
  designId: "d1",
  authorId: "reviewer@example.com",
  body: "why 30s and not 10s?",
  status: "open",
  createdAt: 0,
  updatedAt: 0,
};

// -- buildCommentAnswerContext ---------------------------------------------

test("buildCommentAnswerContext: structured changes supersede the derived path lists", () => {
  const context = buildCommentAnswerContext(design, comment, []);
  assert.match(context, /DECLARED CHANGES:/);
  assert.match(context, /modify src\/net\/retry\.ts::RetryPolicy\.backoff: cap exponential growth at 30s/);
  // `creates`/`touches` are *derived* from `changes` (core's deriveScope), so
  // printing both would spend the budget saying the same thing twice.
  assert.doesNotMatch(context, /^TOUCHES:/m);
});

test("buildCommentAnswerContext: a design with no structured changes falls back to the path lists", () => {
  const context = buildCommentAnswerContext({ ...design, changes: undefined }, comment, []);
  assert.match(context, /TOUCHES: src\/net\/retry\.ts/);
  assert.doesNotMatch(context, /DECLARED CHANGES:/);
});

test("buildCommentAnswerContext: an anchored comment names the specific change it is about", () => {
  const context = buildCommentAnswerContext(design, { ...comment, targetChangeId: "c1" }, []);
  assert.match(context, /THE REVIEWER IS ASKING ABOUT THIS SPECIFIC CHANGE:/);
});

// An amendment can drop the change a comment was anchored to. Losing the
// anchor must never lose the question.
test("buildCommentAnswerContext: an unresolvable anchor still shows the comment, just unanchored", () => {
  const context = buildCommentAnswerContext(design, { ...comment, targetChangeId: "gone" }, []);
  assert.doesNotMatch(context, /THE REVIEWER IS ASKING ABOUT THIS SPECIFIC CHANGE:/);
  assert.match(context, /why 30s and not 10s\?/);
});

test("buildCommentAnswerContext: with no replies, the opening comment is the live question", () => {
  const context = buildCommentAnswerContext(design, comment, []);
  assert.match(context, /THE REVIEWER IS NOW ASKING:\nwhy 30s and not 10s\?/);
  assert.doesNotMatch(context, /CONVERSATION SO FAR:/);
});

// The question to answer is the latest human turn, not the one that opened
// the thread. Pointing the model at the original comment would have it
// re-answer something it has already answered while the live question sat
// buried in the transcript -- which is the whole failure mode of bolting
// follow-ups onto a one-shot answerer.
test("buildCommentAnswerContext: a follow-up becomes the live question, with everything before it as history", () => {
  const replies: DesignCommentReply[] = [
    { commentId: "cm1", authorKind: "agent", message: "it matches the upstream timeout", ts: 1 },
    { commentId: "cm1", authorKind: "human", authorId: "dev@example.com", message: "which upstream?", ts: 2 },
  ];
  const context = buildCommentAnswerContext(design, comment, replies);

  assert.match(context, /THE REVIEWER IS NOW ASKING:\nwhich upstream\?/);
  assert.match(context, /CONVERSATION SO FAR:/);
  assert.match(context, /REVIEWER: why 30s and not 10s\?/, "the opening comment becomes history");
  assert.match(context, /AGENT: it matches the upstream timeout/);
  // The live question must appear once, as the question -- not also inside
  // the transcript above it.
  assert.equal(context.match(/which upstream\?/g)?.length, 1);
});

test("buildCommentAnswerContext: a trailing agent reply doesn't displace the reviewer's last question", () => {
  const replies: DesignCommentReply[] = [
    { commentId: "cm1", authorKind: "human", authorId: "dev@example.com", message: "which upstream?", ts: 1 },
    { commentId: "cm1", authorKind: "agent", message: "the gateway", ts: 2 },
  ];
  const context = buildCommentAnswerContext(design, comment, replies);
  assert.match(context, /THE REVIEWER IS NOW ASKING:\nwhich upstream\?/);
  assert.match(context, /AGENT: the gateway/);
});

// -- answerDesignComment ---------------------------------------------------

test("answerDesignComment: a well-formed answer is returned as-is", async () => {
  const result = await withBedrockEnv(() =>
    withMockFetch(
      async () => llmResponse({ answer: "30s matches the upstream gateway timeout.", needsEscalation: false, escalationReason: "", confidence: "high" }),
      () => answerDesignComment(design, comment, [], { model: "test-model" }),
    ),
  );
  assert.equal(result.needsEscalation, false);
  assert.equal(result.confidence, "high");
  assert.match(result.answer, /upstream gateway timeout/);
});

test("answerDesignComment: a fenced JSON response still parses", async () => {
  const result = await withBedrockEnv(() =>
    withMockFetch(
      async () => llmResponse('```json\n{"answer":"because of the gateway","needsEscalation":false,"escalationReason":"","confidence":"high"}\n```'),
      () => answerDesignComment(design, comment, [], { model: "test-model" }),
    ),
  );
  assert.equal(result.answer, "because of the gateway");
});

// The single most important behaviour in this module, and the one that is
// deliberately the *opposite* of design-semantic-check.ts's. The comparator
// under-flags on failure because inventing a conflict is the worse error;
// here, a comment that looks answered when no model ever ran silently
// swallows review feedback.
test("answerDesignComment: an unreachable model escalates rather than falling silent", async () => {
  const result = await withBedrockEnv(() =>
    withMockFetch(
      async () => {
        throw new Error("network down");
      },
      () => answerDesignComment(design, comment, [], { model: "test-model" }),
    ),
  );
  assert.equal(result.needsEscalation, true);
  assert.equal(result.answer, "");
  assert.match(result.escalationReason, /could not reach a model/);
});

test("answerDesignComment: unparseable JSON escalates after exhausting its retries", async () => {
  let calls = 0;
  const result = await withBedrockEnv(() =>
    withMockFetch(
      async () => {
        calls += 1;
        return llmResponse("I think the answer is probably fine actually");
      },
      () => answerDesignComment(design, comment, [], { model: "test-model" }),
    ),
  );
  assert.equal(calls, 2, "one retry, matching the semantic comparator");
  assert.equal(result.needsEscalation, true);
});

// A model that returns `needsEscalation: false` alongside an empty answer is
// claiming to have answered while saying nothing. Posting that as a reply
// would read to a reviewer as "considered, nothing to say".
test("answerDesignComment: an empty answer escalates whatever the model claimed about it", async () => {
  const result = await withBedrockEnv(() =>
    withMockFetch(
      async () => llmResponse({ answer: "   ", needsEscalation: false, escalationReason: "", confidence: "high" }),
      () => answerDesignComment(design, comment, [], { model: "test-model" }),
    ),
  );
  assert.equal(result.needsEscalation, true);
  assert.notEqual(result.escalationReason, "", "an escalation always says what it needs a human for");
});

test("answerDesignComment: escalating forces confidence to low even if the model said high", async () => {
  const result = await withBedrockEnv(() =>
    withMockFetch(
      async () => llmResponse({ answer: "I would be guessing at the author's intent.", needsEscalation: true, escalationReason: "intent is not stated", confidence: "high" }),
      () => answerDesignComment(design, comment, [], { model: "test-model" }),
    ),
  );
  assert.equal(result.confidence, "low", "a confident escalation is a contradiction");
  assert.equal(result.escalationReason, "intent is not stated");
});

test("answerDesignComment: a missing escalationReason gets a real one rather than an empty string", async () => {
  const result = await withBedrockEnv(() =>
    withMockFetch(
      async () => llmResponse({ answer: "not sure", needsEscalation: true }),
      () => answerDesignComment(design, comment, [], { model: "test-model" }),
    ),
  );
  assert.equal(result.needsEscalation, true);
  assert.match(result.escalationReason, /could not answer this from the design alone/);
});

// -- context budget --------------------------------------------------------
//
// Found in review: every individual field was capped and the whole was not.
// A synthetic 100-message thread produced over a million characters of model
// input, and both attempts of the retry loop would re-send it.

/** The reviewer's reproduction: a long thread of substantial messages. */
function longThread(count: number, chars = 10_000): DesignCommentReply[] {
  return Array.from({ length: count }, (_, i) => ({
    commentId: "cm1",
    authorKind: (i % 2 === 0 ? "agent" : "human") as "agent" | "human",
    message: `msg${i} ${"x".repeat(chars)}`,
    ts: i + 1,
  }));
}

test("buildCommentAnswerContext: a 100-message thread is bounded, not a million characters", () => {
  const context = buildCommentAnswerContext(design, comment, longThread(100));
  assert.ok(context.length <= 48_000, `expected <= 48000 chars, got ${context.length}`);
});

test("buildCommentAnswerContext: the elision is stated, never silent", () => {
  const context = buildCommentAnswerContext(design, comment, longThread(100));
  // A model that cannot see a conversation was cut will answer as though it
  // has the whole thing.
  assert.match(context, /\[… \d+ earlier messages elided …\]/);
});

test("buildCommentAnswerContext: keeps both ends of a long thread, not just one", () => {
  const replies = longThread(100);
  const context = buildCommentAnswerContext(design, comment, replies);
  // The opening turns carry what the reviewer originally wanted; the closing
  // ones carry where the discussion got to. Truncating from either end alone
  // loses one of those.
  assert.match(context, /msg0 /, "the start of the conversation survived");
  assert.match(context, /msg98 /, "so did the end");
});

// The live question is what is being answered; truncating it is the one loss
// that makes the answer wrong rather than merely thinner.
test("buildCommentAnswerContext: the live question survives a thread that fills the budget", () => {
  const replies = [...longThread(100), { commentId: "cm1", authorKind: "human" as const, message: "so which upstream is it?", ts: 999 }];
  const context = buildCommentAnswerContext(design, comment, replies);
  assert.ok(context.length <= 48_000);
  assert.match(context, /THE REVIEWER IS NOW ASKING:\nso which upstream is it\?/);
});

test("buildCommentAnswerContext: one pasted log doesn't consume the whole budget", () => {
  const replies: DesignCommentReply[] = [
    { commentId: "cm1", authorKind: "human", message: `PASTED ${"L".repeat(500_000)}`, ts: 1 },
    { commentId: "cm1", authorKind: "agent", message: "the gateway", ts: 2 },
    { commentId: "cm1", authorKind: "human", message: "but why 30s?", ts: 3 },
  ];
  const context = buildCommentAnswerContext(design, comment, replies);
  assert.ok(context.length <= 48_000, `got ${context.length}`);
  assert.match(context, /THE REVIEWER IS NOW ASKING:\nbut why 30s\?/);
  assert.match(context, /AGENT: the gateway/, "the rest of the conversation still fits");
});

// A reviewer can paste a log as the question itself.
test("buildCommentAnswerContext: an enormous live question is capped rather than blowing the budget", () => {
  const replies: DesignCommentReply[] = [{ commentId: "cm1", authorKind: "human", message: "W".repeat(500_000), ts: 1 }];
  const context = buildCommentAnswerContext(design, comment, replies);
  assert.ok(context.length <= 48_000, `got ${context.length}`);
  assert.match(context, /truncated/);
});

// The transcript budget can't help when the design's own fields are the
// problem -- a design declaring hundreds of changes does it with no
// conversation at all.
test("buildCommentAnswerContext: a design with an enormous declaration is still bounded", () => {
  const huge = {
    ...design,
    changes: Array.from({ length: 5000 }, (_, i) => ({ id: `c${i}`, action: "modify" as const, target: `src/f${i}.ts`, intent: "x".repeat(200) })),
  };
  const context = buildCommentAnswerContext(huge, comment, []);
  assert.ok(context.length <= 48_000, `got ${context.length}`);
  assert.match(context, /THE REVIEWER IS NOW ASKING:\nwhy 30s and not 10s\?/, "the question survives whatever else is dropped");
});

// Found in review: the fallback sliced to the budget and then asked
// `truncate` to cut at that same budget, so its length test was false and the
// marker was never appended -- a 60k design became a 48k context with nothing
// saying so. A cut the model cannot see is one it answers straight through.
test("buildCommentAnswerContext: an oversized design says it was cut, rather than cutting silently", () => {
  // ~60k characters of declaration, matching the reviewer's reproduction.
  const huge = {
    ...design,
    changes: Array.from({ length: 300 }, (_, i) => ({ id: `c${i}`, action: "modify" as const, target: `src/f${i}.ts`, intent: "y".repeat(180) })),
  };
  const context = buildCommentAnswerContext(huge, comment, []);

  assert.ok(context.length <= 48_000, `got ${context.length}`);
  assert.match(context, /too long to include/, "the elision has to be visible to the model");
  assert.match(context, /THE REVIEWER IS NOW ASKING:\nwhy 30s and not 10s\?/, "and the question still follows it");
});

test("buildCommentAnswerContext: a design that fits carries no elision marker", () => {
  const context = buildCommentAnswerContext(design, comment, []);
  assert.doesNotMatch(context, /too long to include/);
});

test("buildCommentAnswerContext: a short thread is passed through whole, with no elision marker", () => {
  const replies: DesignCommentReply[] = [
    { commentId: "cm1", authorKind: "agent", message: "it matches the upstream timeout", ts: 1 },
    { commentId: "cm1", authorKind: "human", authorId: "dev@example.com", message: "which upstream?", ts: 2 },
  ];
  const context = buildCommentAnswerContext(design, comment, replies);
  assert.doesNotMatch(context, /elided/);
  assert.match(context, /AGENT: it matches the upstream timeout/);
});
