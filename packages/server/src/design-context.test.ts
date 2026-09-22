/**
 * `assembleDesignContext`. Three properties carry the weight, in this order:
 * a secret that survived in a stored capture never reaches the model, a gap
 * in the conversation is always visible, and the whole prompt stays inside
 * its budget however large the design or the session.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { DesignStatement } from "@twing/core";
import type { CaptureSlice } from "./capture-store.js";
import { assembleDesignContext, describeProvenance, designScopePaths, MAX_CONTEXT_CHARS } from "./design-context.js";

/** A real session id shape -- a uuid, which is what every harness twing
 * supports produces. It matters here because provenance abbreviates it. */
const SESSION_ID = "7f3a1c42-9e21-4b6d-8a55-0c1e2d3f4a5b";

const design: DesignStatement = {
  id: "d1",
  projectId: "p1",
  developerId: "dev@example.com",
  sessionId: SESSION_ID,
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

function slice(turns: { index: number; role?: "user" | "assistant"; text: string }[], overrides: Partial<CaptureSlice> = {}): CaptureSlice {
  return {
    sessionId: SESSION_ID,
    turns: turns.map((t) => ({ index: t.index, record: { type: "turn", role: t.role ?? "assistant", text: t.text } })),
    other: [],
    totalTurns: overrides.totalTurns ?? turns.length,
    keptTurns: turns.length,
    touchedFocusPaths: overrides.touchedFocusPaths ?? [],
    ...overrides,
  };
}

// -- scope -----------------------------------------------------------------

test("designScopePaths: a symbol target is cut back to the file a capture would record", () => {
  assert.deepEqual(designScopePaths(design), ["src/net/retry.ts"]);
});

test("designScopePaths: merges creates, touches and change targets without duplicating", () => {
  const paths = designScopePaths({ ...design, creates: ["src/new.ts"], touches: ["src/net/retry.ts", "src/new.ts"] });
  assert.deepEqual([...paths].sort(), ["src/net/retry.ts", "src/new.ts"]);
});

// -- the security property -------------------------------------------------
//
// The reason redaction moved into core and runs a second time here: what is
// on disk was scrubbed by whatever version shipped when it was written, and
// POST /v1/captures takes records from any authenticated client without
// scrubbing them at all. While nothing read captures a miss was inert. It
// stopped being inert when captured turns started grounding answers a whole
// project reads.

test("a credential that survived into a stored capture never reaches the model", () => {
  const secrets = [
    "here is the token ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa and it works",
    "export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY",
    "postgres://admin:hunter2@db.internal:5432/prod",
    "ANTHROPIC_API_KEY=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  ];
  const { context } = assembleDesignContext(design, slice(secrets.map((text, index) => ({ index, text }))));

  for (const needle of ["ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY", "hunter2", "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"]) {
    assert.ok(!context.includes(needle), `unredacted secret reached the prompt: ${needle}`);
  }
  assert.match(context, /\[redacted\]/, "and the redaction is visible rather than the text silently vanishing");
});

test("redaction does not gut the prose around it", () => {
  const { context } = assembleDesignContext(design, slice([{ index: 0, text: "I set the timeout to 30s because the gateway gives up at 31s" }]));
  assert.match(context, /the gateway gives up at 31s/);
});

// -- grounding and its absence ---------------------------------------------

test("an uncaptured session is stated, not silently answered from the design alone", () => {
  const { context, provenance } = assembleDesignContext(design, undefined);
  assert.match(context, /not available -- this repository has not opted into session capture/);
  assert.equal(provenance.captured, false);
  assert.equal(provenance.turnsUsed, 0);
  assert.match(describeProvenance(provenance), /has not opted into session capture/);
});

test("a captured-but-empty session reads differently from one that was never captured", () => {
  const { context, provenance } = assembleDesignContext(design, slice([], { totalTurns: 0 }));
  assert.match(context, /captured but holds no conversation/);
  // Distinct facts: one is a consent decision, the other is a bug.
  assert.equal(provenance.captured, true);
  assert.match(describeProvenance(provenance), /captured but held no usable conversation/);
});

test("a grounded context carries the conversation and labels who said what", () => {
  const { context, provenance } = assembleDesignContext(
    design,
    slice([
      { index: 0, role: "user", text: "make retries less aggressive" },
      { index: 1, role: "assistant", text: "capping backoff at 30s" },
    ]),
  );
  assert.match(context, /SESSION TRANSCRIPT/);
  assert.match(context, /DEVELOPER: make retries less aggressive/);
  assert.match(context, /AGENT: capping backoff at 30s/);
  assert.equal(provenance.turnsUsed, 2);
});

// A model that cannot tell a gap from a whole conversation answers straight
// through it.
test("a gap in the conversation is marked where it happened, not summed at the end", () => {
  const { context } = assembleDesignContext(
    design,
    slice(
      [
        { index: 0, text: "first" },
        { index: 1, text: "second" },
        { index: 97, text: "much later" },
      ],
      { totalTurns: 120 },
    ),
  );
  assert.match(context, /\[… 95 turns elided …\]/);
  // Between the two it belongs to, not appended after everything.
  assert.ok(context.indexOf("second") < context.indexOf("95 turns elided"));
  assert.ok(context.indexOf("95 turns elided") < context.indexOf("much later"));
});

test("a single elided turn is phrased in the singular", () => {
  const { context } = assembleDesignContext(
    design,
    slice(
      [
        { index: 0, text: "first" },
        { index: 2, text: "third" },
      ],
      { totalTurns: 3 },
    ),
  );
  assert.match(context, /\[… 1 turn elided …\]/);
});

test("a contiguous conversation carries no elision marker at all", () => {
  const { context } = assembleDesignContext(
    design,
    slice([
      { index: 0, text: "first" },
      { index: 1, text: "second" },
    ]),
  );
  assert.doesNotMatch(context, /elided/);
});

// -- relevance -------------------------------------------------------------

test("the model is told which of the design's files the session actually touched", () => {
  const { context, provenance } = assembleDesignContext(design, slice([{ index: 0, text: "x" }], { touchedFocusPaths: ["src/net/retry.ts"] }));
  assert.match(context, /observed touching: src\/net\/retry\.ts/);
  assert.deepEqual(provenance.touchedPaths, ["src/net/retry.ts"]);
  assert.deepEqual(provenance.untouchedPaths, []);
});

// A design whose own files never appear in its own session is worth a
// reviewer's suspicion, so the absence is said out loud rather than omitted.
test("a session that never touched this design's files says so", () => {
  const { context, provenance } = assembleDesignContext(design, slice([{ index: 0, text: "x" }]));
  assert.match(context, /not observed touching any of the files this design declares/);
  assert.deepEqual(provenance.untouchedPaths, ["src/net/retry.ts"]);
});

// -- budget ----------------------------------------------------------------

test("a vast conversation stays inside the budget", () => {
  const turns = Array.from({ length: 400 }, (_, index) => ({ index, text: `turn ${index} ${"x".repeat(5_000)}` }));
  const { context } = assembleDesignContext(design, slice(turns, { totalTurns: 400 }));
  assert.ok(context.length <= MAX_CONTEXT_CHARS, `got ${context.length}`);
});

test("one pasted log does not consume the transcript budget", () => {
  const { context } = assembleDesignContext(
    design,
    slice([
      { index: 0, text: `PASTED ${"L".repeat(500_000)}` },
      { index: 1, text: "and then I capped it at 30s" },
    ]),
  );
  assert.ok(context.length <= MAX_CONTEXT_CHARS);
  assert.match(context, /and then I capped it at 30s/, "the rest of the conversation still fits");
});

test("the design always survives, however long the conversation", () => {
  const turns = Array.from({ length: 400 }, (_, index) => ({ index, text: `turn ${index} ${"x".repeat(5_000)}` }));
  const { context } = assembleDesignContext(design, slice(turns, { totalTurns: 400 }));
  assert.match(context, /DESIGN SUMMARY:\nAdd a retry budget to the HTTP client/);
  assert.match(context, /DECLARED CHANGES:/);
});

// The transcript budget cannot help when the design's own declaration is the
// thing that overflows -- a design with hundreds of changes does it with no
// conversation at all.
test("an oversized design is cut visibly, never silently", () => {
  const huge = {
    ...design,
    changes: Array.from({ length: 5_000 }, (_, i) => ({ id: `c${i}`, action: "modify" as const, target: `src/f${i}.ts`, intent: "x".repeat(200) })),
  };
  const { context } = assembleDesignContext(huge, undefined);
  assert.ok(context.length <= MAX_CONTEXT_CHARS, `got ${context.length}`);
  assert.match(context, /too long to include/);
});

// The cut is in the *middle* now, not at the end: both ends get a reserved
// share of the budget, so the most recent turn is always present and what
// goes missing is the part between.
test("a conversation cut short by the budget is cut in the middle, and says so", () => {
  const turns = Array.from({ length: 200 }, (_, index) => ({ index, text: `turn ${index} ${"y".repeat(2_000)}` }));
  const { context, provenance } = assembleDesignContext(design, slice(turns, { totalTurns: 200 }));
  assert.match(context, /\[… \d+ turns elided …\]/);
  assert.match(context, /turn 199 /, "the end of the conversation is never what gets dropped");
  assert.ok(provenance.turnsUsed < 200);
  assert.equal(provenance.turnsUsed + provenance.turnsElided, 200);
});

// -- provenance crosses the wire; the transcript does not -------------------

test("describeProvenance reports counts and an id, never conversation text", () => {
  const { provenance } = assembleDesignContext(
    design,
    slice(
      [
        { index: 0, text: "a distinctive phrase nobody else would write" },
        { index: 9, text: "another one" },
      ],
      { totalTurns: 50, touchedFocusPaths: ["src/net/retry.ts"] },
    ),
  );
  const line = describeProvenance(provenance);
  assert.match(line, /Grounded in 2 of 50 turns from session 7f3a1c42\./);
  assert.match(line, /Touched 1 of 1 declared file\./);
  assert.ok(!line.includes("distinctive phrase"), "provenance must never carry transcript text");
});

test("provenance names only a short session prefix, not the whole id", () => {
  const { provenance } = assembleDesignContext(design, slice([{ index: 0, text: "x" }]));
  const line = describeProvenance(provenance);
  assert.ok(!line.includes(SESSION_ID), "the whole id is not the reviewer's business");
  assert.match(line, /session 7f3a1c42\b/);
});

// -- both ends of a long session (found in review) --------------------------
//
// The assembler filled the transcript budget oldest-first and stopped, so a
// 300-turn conversation rendered as its first 17 turns with the entire recent
// half silently gone -- defeating the reason the reader keeps a tail at all.

test("a long session keeps where the work got to, not only where it started", () => {
  const turns = Array.from({ length: 300 }, (_, index) => ({ index, text: `turn ${index} ${"x".repeat(900)}` }));
  const { context } = assembleDesignContext(design, slice(turns, { totalTurns: 300 }));

  assert.match(context, /turn 0 /, "the opening survived");
  assert.match(context, /turn 299 /, "and so did the most recent turn");
});

test("the cut lands in the middle, and says how much it took", () => {
  const turns = Array.from({ length: 300 }, (_, index) => ({ index, text: `turn ${index} ${"x".repeat(900)}` }));
  const { context, provenance } = assembleDesignContext(design, slice(turns, { totalTurns: 300 }));

  assert.match(context, /\[… \d+ turns elided …\]/);
  assert.ok(provenance.turnsUsed > 0 && provenance.turnsUsed < 300);
  assert.equal(provenance.turnsUsed + provenance.turnsElided, 300);
});

test("both ends get a share even when one turn is enormous", () => {
  const { context } = assembleDesignContext(
    design,
    slice(
      [
        { index: 0, text: `opening ${"a".repeat(40_000)}` },
        { index: 1, text: "middle" },
        { index: 2, text: "the most recent thing said" },
      ],
      { totalTurns: 3 },
    ),
  );
  assert.match(context, /the most recent thing said/, "a huge opening turn must not eat the tail's share");
});

// -- one budget across the whole prompt (found in review) -------------------

test("a caller-supplied budget is respected, not just the module default", () => {
  const turns = Array.from({ length: 300 }, (_, index) => ({ index, text: `turn ${index} ${"x".repeat(900)}` }));
  const { context } = assembleDesignContext(design, slice(turns, { totalTurns: 300 }), { budgetChars: 12_000 });
  assert.ok(context.length <= 12_000, `got ${context.length}`);
});

test("a budget too small for the design still yields the design, cut visibly", () => {
  const { context } = assembleDesignContext(design, undefined, { budgetChars: 200 });
  assert.ok(context.length <= 200);
  assert.match(context, /too long to include/);
});

test("a zero budget does not throw or produce a negative slice", () => {
  const { context } = assembleDesignContext(design, slice([{ index: 0, text: "x" }]), { budgetChars: 0 });
  assert.equal(context.length, 0);
});
