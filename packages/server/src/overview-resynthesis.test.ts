import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  originalText,
  amendmentTexts,
  amendmentsSinceOverview,
  shouldResynthesize,
  proposeOverview,
  resynthesizeNow,
  ResynthesisQueue,
  rephraseAvailability,
  isHumanWritten,
  cachedProposal,
  __clearProposalCache,
  AMENDMENT_THRESHOLD,
  type ResynthesisDeps,
} from "./overview-resynthesis.js";
import { appendSummaryUpdate } from "./design-checks.js";
import type { DesignStatement } from "@twing/core";
import type { ActivityEvent } from "./activity-log.js";

// The proposal cache is module state and deliberately survives calls -- which
// makes tests non-independent unless it is reset. Cleared per test rather than
// per file so the cache's own tests can still observe it filling.
beforeEach(() => __clearProposalCache());

function design(overrides: Partial<DesignStatement> = {}): DesignStatement {
  return {
    id: "d1",
    groupId: "d1",
    projectId: "p1",
    developerId: "alice@example.com",
    sessionId: "s1",
    status: "open",
    createdAt: 1_000,
    summary: "Reworks the sync client so a dropped connection resumes.",
    creates: [],
    touches: [],
    dependsOn: [],
    ttlMs: 1_000,
    scopeVersion: 1,
    lastActivityAt: 1_000,
    justifiedConstraintIds: [],
    justifiedOverlaps: [],
    justifiedConflicts: [],
    justifiedSymbolConflicts: [],
    ...overrides,
  } as DesignStatement;
}

function amendEvent(ts: number): ActivityEvent {
  return { id: `e${ts}`, projectId: "p1", kind: "design_amended", relatedId: "d1", ts } as ActivityEvent;
}

/** A deps bundle whose model, writes and log are all observable. Defaults to
 * a model that echoes a fixed answer, since most tests care about the guards
 * rather than the text. */
function stubDeps(overrides: Partial<ResynthesisDeps> & { design?: DesignStatement } = {}) {
  const written: { id: string; summary: string }[] = [];
  const prompts: { system: string; user: string }[] = [];
  let current = overrides.design ?? design();
  const deps: ResynthesisDeps = {
    getDesign: () => current,
    eventsFor: () => [],
    commentsFor: () => [],
    callModel: async (system, user) => {
      prompts.push({ system, user });
      return "One current overview.";
    },
    writeOverview: (id, summary) => written.push({ id, summary }),
    log: () => {},
    ...overrides,
  };
  return { deps, written, prompts, setDesign: (d: DesignStatement) => (current = d) };
}

// --- reading the pile -------------------------------------------------------

test("originalText: the design's own text, before any amendment", () => {
  const summary = appendSummaryUpdate("The original intent.", "and also this");
  assert.equal(originalText(design({ summary })), "The original intent.");
});

test("originalText: prefers the extraction-time original when one is stored", () => {
  const d = design({ summary: "A rewritten overview.", summaryExtracted: "What the extractor first wrote." });
  assert.equal(originalText(d), "What the extractor first wrote.");
});

// The Rewrite button's case: a human has already rewritten this overview and
// amendments have landed since. Their text is the base -- rebuilding from the
// machine's first draft would discard the rewrite they asked for.
test("originalText: after an owner edit, the owner's text is the base, not summaryExtracted", () => {
  const d = design({
    summary: appendSummaryUpdate("What I actually meant.", "and now also this"),
    summaryExtracted: "What the extractor first wrote.",
    overviewRevision: 1,
    overviewRevisionSource: "owner_edit",
  });
  assert.equal(originalText(d), "What I actually meant.");
});

test("amendmentTexts: every appended entry, in order, marker stripped", () => {
  const summary = appendSummaryUpdate(appendSummaryUpdate("Base.", "first"), "second");
  assert.deepEqual(amendmentTexts(design({ summary })), ["first", "second"]);
});

test("amendmentTexts: none for a design nobody has amended", () => {
  assert.deepEqual(amendmentTexts(design()), []);
});

// Counted from events, not from markers: after a rewrite the markers are
// gone, so a marker count would reset to zero and the threshold would never
// trip again on a design that keeps being amended.
test("amendmentsSinceOverview: counts only amendments newer than the last rewrite", () => {
  const d = design({ overviewRevisedAt: 100 });
  const events = [amendEvent(50), amendEvent(150), amendEvent(200)];
  assert.equal(amendmentsSinceOverview(d, events), 2);
});

test("amendmentsSinceOverview: a design never rewritten counts every amendment", () => {
  assert.equal(amendmentsSinceOverview(design(), [amendEvent(1), amendEvent(2)]), 2);
});

// --- the guards -------------------------------------------------------------

// THE guard. Once a person has written the overview, nothing automatic
// rewrites it, however deep the pile gets -- the monitor nudges them instead.
test("shouldResynthesize: refuses to touch an overview a human wrote", () => {
  const d = design({ overviewRevisionSource: "owner_edit" });
  const events = [amendEvent(1), amendEvent(2), amendEvent(3), amendEvent(4)];
  assert.equal(shouldResynthesize(d, events, [], "amendment_threshold"), "human_wrote_it");
  // ...and a human pressing the button does not override that either: the
  // route hands the proposal back for them to save as their own edit.
  assert.equal(shouldResynthesize(d, events, [], "manual"), "human_wrote_it");
  assert.equal(shouldResynthesize(d, events, [], "design_closed"), "human_wrote_it");
});

// The objection this whole design answers: a rewrite moves the exact text
// open comments are anchored into, so it waits while a review is live.
test("shouldResynthesize: waits while an open comment is anchored in the summary", () => {
  const events = [amendEvent(1), amendEvent(2), amendEvent(3)];
  const comments = [{ status: "open", anchor: { field: "summary" } }];
  assert.equal(shouldResynthesize(design(), events, comments, "design_closed"), "open_anchored_comments");
});

test("shouldResynthesize: a resolved comment is no obstacle", () => {
  const comments = [{ status: "resolved", anchor: { field: "summary" } }];
  assert.equal(shouldResynthesize(design(), [amendEvent(1)], comments, "design_closed"), undefined);
});

// Anchored elsewhere, so a rewrite of the summary cannot move it.
test("shouldResynthesize: a comment anchored in another field is no obstacle", () => {
  const comments = [{ status: "open", anchor: { field: "plan" } }];
  assert.equal(shouldResynthesize(design(), [amendEvent(1)], comments, "design_closed"), undefined);
});

test("shouldResynthesize: the threshold gates the mid-flight trigger only", () => {
  const events = [amendEvent(1)];
  assert.equal(shouldResynthesize(design(), events, [], "amendment_threshold"), "not_enough_amendments");
  // Closing is the moment the overview becomes the permanent record, so one
  // amendment is worth folding there.
  assert.equal(shouldResynthesize(design(), events, [], "design_closed"), undefined);
  assert.equal(shouldResynthesize(design(), events, [], "manual"), undefined);
});

test("shouldResynthesize: allows the threshold trigger once the pile is deep enough", () => {
  const events = Array.from({ length: AMENDMENT_THRESHOLD }, (_, i) => amendEvent(i + 1));
  assert.equal(shouldResynthesize(design(), events, [], "amendment_threshold"), undefined);
});

test("shouldResynthesize: no design is a refusal, not a crash", () => {
  assert.equal(shouldResynthesize(undefined, [], [], "manual"), "no_such_design");
});

// --- proposing --------------------------------------------------------------

test("proposeOverview: returns the model's text and writes nothing", async () => {
  const summary = appendSummaryUpdate("Base.", "first");
  const { deps, written } = stubDeps({ design: design({ summary }) });

  assert.equal(await proposeOverview(deps, "d1"), "One current overview.");
  assert.deepEqual(written, []);
});

test("proposeOverview: nothing to propose for a design with no amendments", async () => {
  const { deps, prompts } = stubDeps();
  assert.equal(await proposeOverview(deps, "d1"), undefined);
  // ...and no model call was spent finding that out.
  assert.deepEqual(prompts, []);
});

// Fail soft, the same rule extraction and the semantic check follow: the
// design keeps the text it has. An outage must never blank a design.
test("proposeOverview: a model failure keeps the existing text", async () => {
  const summary = appendSummaryUpdate("Base.", "first");
  const { deps } = stubDeps({
    design: design({ summary }),
    callModel: async () => {
      throw new Error("no provider configured");
    },
  });
  assert.equal(await proposeOverview(deps, "d1"), undefined);
});

// An empty string would otherwise pass straight through reviseOverview.
test("proposeOverview: an empty answer is treated as a failure", async () => {
  const summary = appendSummaryUpdate("Base.", "first");
  const { deps } = stubDeps({ design: design({ summary }), callModel: async () => "   " });
  assert.equal(await proposeOverview(deps, "d1"), undefined);
});

// The telephone-game guard: the prompt is built from the extraction-time
// original plus the amendments, never from a previous synthesis.
test("proposeOverview: feeds the original and the amendments, not the current summary", async () => {
  const summary = appendSummaryUpdate("A rewritten overview.", "a later amendment");
  const d = design({ summary, summaryExtracted: "What the extractor first wrote.", overviewRevision: 1 });
  const { deps, prompts } = stubDeps({ design: d });

  await proposeOverview(deps, "d1");
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].user, /What the extractor first wrote\./);
  assert.match(prompts[0].user, /a later amendment/);
  assert.doesNotMatch(prompts[0].user, /A rewritten overview\./);
});

// --- writing ----------------------------------------------------------------

test("resynthesizeNow: writes the proposal once the guards pass", async () => {
  const summary = appendSummaryUpdate("Base.", "first");
  const { deps, written } = stubDeps({ design: design({ summary }) });

  assert.equal(await resynthesizeNow(deps, "d1", "design_closed"), "written");
  assert.deepEqual(written, [{ id: "d1", summary: "One current overview." }]);
});

test("resynthesizeNow: a refused run writes nothing", async () => {
  const summary = appendSummaryUpdate("Base.", "first");
  const { deps, written } = stubDeps({ design: design({ summary, overviewRevisionSource: "owner_edit" }) });

  assert.equal(await resynthesizeNow(deps, "d1", "design_closed"), "human_wrote_it");
  assert.deepEqual(written, []);
});

// The race the version guard exists for: an amend lands while the model is
// running, so the proposal describes a design that no longer exists.
test("resynthesizeNow: discards a proposal when the design moved during the call", async () => {
  const summary = appendSummaryUpdate("Base.", "first");
  const before = design({ summary });
  const stub = stubDeps({ design: before });
  stub.deps.callModel = async () => {
    stub.setDesign(design({ summary: appendSummaryUpdate(summary, "second"), scopeVersion: 2 }));
    return "One current overview.";
  };

  assert.equal(await resynthesizeNow(stub.deps, "d1", "design_closed"), "design_moved");
  assert.deepEqual(stub.written, []);
});

// The other race, and the reason the guards re-run rather than only the
// version check: an owner edit changes whose text it is.
test("resynthesizeNow: discards a proposal when a human edits during the call", async () => {
  const summary = appendSummaryUpdate("Base.", "first");
  const stub = stubDeps({ design: design({ summary }) });
  stub.deps.callModel = async () => {
    // Same scopeVersion and the same revision count -- only the source
    // changed, which the version check alone would not catch.
    stub.setDesign(design({ summary, overviewRevisionSource: "owner_edit" }));
    return "One current overview.";
  };

  assert.equal(await resynthesizeNow(stub.deps, "d1", "design_closed"), "human_wrote_it");
  assert.deepEqual(stub.written, []);
});

// --- the queue --------------------------------------------------------------

/** A design deep enough into its pile that the threshold trigger will act --
 * three appended entries and the three events that recorded them. Without the
 * events the queue tests pass for the wrong reason: the job refuses on the
 * threshold and writes nothing, which is indistinguishable from the debounce
 * working. */
function amendedPastThreshold() {
  let summary = "Base.";
  for (let i = 0; i < AMENDMENT_THRESHOLD; i++) summary = appendSummaryUpdate(summary, `amendment ${i + 1}`);
  const events = Array.from({ length: AMENDMENT_THRESHOLD }, (_, i) => amendEvent(i + 1));
  return { summary, events };
}

test("ResynthesisQueue: coalesces a burst into one run", async () => {
  const { summary, events } = amendedPastThreshold();
  const { deps, written } = stubDeps({ design: design({ summary }), eventsFor: () => events });
  const queue = new ResynthesisQueue(deps, 5);

  queue.enqueue("d1", "amendment_threshold");
  queue.enqueue("d1", "amendment_threshold");
  queue.enqueue("d1", "amendment_threshold");
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(written.length, 1);
  queue.clear();
});

test("ResynthesisQueue: clear() cancels a pending run", async () => {
  const { summary, events } = amendedPastThreshold();
  const { deps, written } = stubDeps({ design: design({ summary }), eventsFor: () => events });
  const queue = new ResynthesisQueue(deps, 5);

  queue.enqueue("d1", "amendment_threshold");
  queue.clear();
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.deepEqual(written, []);
});

// Single-flight: a second trigger arriving mid-run re-runs once at the end
// rather than starting a second model call against the same row.
test("ResynthesisQueue: a trigger during a run re-runs once, not concurrently", async () => {
  const summary = appendSummaryUpdate("Base.", "first");
  const stub = stubDeps({ design: design({ summary }) });
  let inFlight = 0;
  let maxInFlight = 0;
  const queue = new ResynthesisQueue(stub.deps, 1);
  stub.deps.callModel = async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 10));
    inFlight--;
    return "One current overview.";
  };

  const first = queue.run("d1", "design_closed");
  await new Promise((resolve) => setTimeout(resolve, 2));
  await queue.run("d1", "design_closed");
  await first;

  assert.equal(maxInFlight, 1);
  assert.equal(stub.written.length, 2); // the in-flight one, then the re-run
  queue.clear();
});

// --- the manual path: who may rephrase, and when it does anything ----------

test("rephraseAvailability: machine-written text needs one amendment", () => {
  const d = design();
  assert.deepEqual(rephraseAvailability(d, []), { allowed: false, reason: "nothing_new" });
  assert.deepEqual(rephraseAvailability(d, [amendEvent(1)]), { allowed: true });
});

// Nobody is attached to prose a machine wrote; a paragraph somebody chose is
// theirs, and absorbing a single line into it is a bad trade.
test("rephraseAvailability: human-written text needs two", () => {
  for (const source of ["owner_edit", "rephrase_accepted"]) {
    const d = design({ overviewRevisionSource: source, overviewRevision: 1 });
    assert.deepEqual(rephraseAvailability(d, [amendEvent(1)]), { allowed: false, reason: "human_text_barely_changed" }, source);
    assert.deepEqual(rephraseAvailability(d, [amendEvent(1), amendEvent(2)]), { allowed: true }, source);
  }
});

// A rephrase is not final: new amendments re-arm the button.
test("rephraseAvailability: amendments after a rephrase re-enable it", () => {
  const d = design({ overviewRevision: 1, overviewRevisedAt: 100, overviewRevisionSource: "llm_resynthesis" });
  assert.deepEqual(rephraseAvailability(d, [amendEvent(50)]), { allowed: false, reason: "nothing_new" }, "an older amendment does not count");
  assert.deepEqual(rephraseAvailability(d, [amendEvent(50), amendEvent(150)]), { allowed: true });
});

test("isHumanWritten: both an edit and an accepted rephrase count", () => {
  assert.equal(isHumanWritten(design({ overviewRevisionSource: "owner_edit" })), true);
  assert.equal(isHumanWritten(design({ overviewRevisionSource: "rephrase_accepted" })), true);
  assert.equal(isHumanWritten(design({ overviewRevisionSource: "llm_resynthesis" })), false);
  assert.equal(isHumanWritten(design()), false);
});

// The automatic path keeps its hands off anything a person settled on --
// including a rephrase a teammate accepted.
test("shouldResynthesize: an accepted rephrase is as untouchable as a hand edit", () => {
  const d = design({ overviewRevisionSource: "rephrase_accepted" });
  assert.equal(shouldResynthesize(d, [amendEvent(1), amendEvent(2), amendEvent(3)], [], "design_closed"), "human_wrote_it");
});

// --- the cache -------------------------------------------------------------

test("proposeOverview: a second call for the same state costs no model call", async () => {
  __clearProposalCache();
  const summary = appendSummaryUpdate("Base.", "first");
  const { deps, prompts } = stubDeps({ design: design({ summary }) });

  assert.equal(await proposeOverview(deps, "d1"), "One current overview.");
  assert.equal(await proposeOverview(deps, "d1"), "One current overview.");
  assert.equal(prompts.length, 1, "the model ran once for two presses");
});

// The key is what expires an entry: change, never age.
test("proposeOverview: an amendment retires the cached proposal", async () => {
  __clearProposalCache();
  const summary = appendSummaryUpdate("Base.", "first");
  const stub = stubDeps({ design: design({ summary }) });

  await proposeOverview(stub.deps, "d1");
  // A new amendment bumps scopeVersion, which is in the cache key.
  stub.setDesign(design({ summary: appendSummaryUpdate(summary, "second"), scopeVersion: 2 }));
  await proposeOverview(stub.deps, "d1");

  assert.equal(stub.prompts.length, 2, "the model ran again for the changed design");
});

test("proposeOverview: saving a rephrase retires the cached proposal", async () => {
  __clearProposalCache();
  const summary = appendSummaryUpdate("Base.", "first");
  const stub = stubDeps({ design: design({ summary }) });

  await proposeOverview(stub.deps, "d1");
  stub.setDesign(design({ summary, overviewRevision: 1, overviewRevisionSource: "rephrase_accepted" }));
  await proposeOverview(stub.deps, "d1");

  assert.equal(stub.prompts.length, 2);
});

test("cachedProposal: nothing for a state never computed", () => {
  __clearProposalCache();
  assert.equal(cachedProposal(design()), undefined);
});
