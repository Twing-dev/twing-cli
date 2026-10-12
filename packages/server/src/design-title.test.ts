import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanTitle, refreshGeneratedTitle, MAX_GENERATED_TITLE_CHARS, type TitleDeps } from "./design-title.js";
import type { DesignStatement } from "@twing/core";

function design(overrides: Partial<DesignStatement> = {}): DesignStatement {
  return {
    id: "d1",
    groupId: "d1",
    projectId: "p1",
    developerId: "alice@example.com",
    sessionId: "s1",
    status: "open",
    createdAt: 1_000,
    summary: "Problem: Diagrams go stale after an amend.\nApproach:\n- The author says whether they still fit.",
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

/** Deps whose model answer, writes and prompts are observable. `onCall` runs
 * while the model is "thinking", so a test can change the design mid-call. */
function stubDeps(answer: string | Error, onCall?: (deps: { current: DesignStatement }) => void) {
  const state = { current: design() };
  const written: { id: string; title: string }[] = [];
  const prompts: { system: string; user: string; purpose: string }[] = [];
  const deps: TitleDeps = {
    getDesign: (id) => (id === state.current.id ? state.current : undefined),
    callModel: async (system, user, tag) => {
      prompts.push({ system, user, purpose: tag.purpose });
      onCall?.(state);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    writeTitle: (id, title) => written.push({ id, title }),
    log: () => {},
  };
  return { deps, state, written, prompts };
}

test("cleanTitle: strips the wrapping a model adds and keeps only the first line", () => {
  assert.equal(cleanTitle('"Keep diagrams fresh on amend."'), "Keep diagrams fresh on amend");
  assert.equal(cleanTitle("Title: Keep diagrams fresh on amend"), "Keep diagrams fresh on amend");
  assert.equal(cleanTitle("**Keep diagrams fresh**\nBecause they go stale."), "Keep diagrams fresh");
});

test("cleanTitle: rejects empty output and prose too long to be a heading", () => {
  assert.equal(cleanTitle("   "), undefined);
  assert.equal(cleanTitle("x".repeat(MAX_GENERATED_TITLE_CHARS + 1)), undefined);
});

test("refreshGeneratedTitle writes the cleaned heading, tagged design_title, with the summary in the prompt", async () => {
  const { deps, written, prompts } = stubDeps("Keep diagrams fresh on amend.");
  assert.equal(await refreshGeneratedTitle(deps, "d1"), "written");
  assert.deepEqual(written, [{ id: "d1", title: "Keep diagrams fresh on amend" }]);
  assert.equal(prompts[0].purpose, "design_title");
  assert.match(prompts[0].user, /Diagrams go stale after an amend/);
});

test("refreshGeneratedTitle includes the plan when the design has one", async () => {
  const { deps, state, prompts } = stubDeps("Keep diagrams fresh");
  state.current = design({ rawPlanExcerpt: "Ask the author on every amend." });
  await refreshGeneratedTitle(deps, "d1");
  assert.match(prompts[0].user, /PLAN:\nAsk the author on every amend\./);
});

test("refreshGeneratedTitle keeps the existing heading when the model fails or returns nothing usable", async () => {
  const failing = stubDeps(new Error("provider down"));
  assert.equal(await refreshGeneratedTitle(failing.deps, "d1"), "no_title");
  assert.deepEqual(failing.written, []);

  const empty = stubDeps("  ");
  assert.equal(await refreshGeneratedTitle(empty.deps, "d1"), "no_title");
  assert.deepEqual(empty.written, []);
});

test("refreshGeneratedTitle drops the heading when the summary changed while the model ran", async () => {
  const { deps, written } = stubDeps("Keep diagrams fresh", (state) => {
    state.current = design({ summary: "Something else entirely." });
  });
  assert.equal(await refreshGeneratedTitle(deps, "d1"), "design_moved");
  assert.deepEqual(written, []);
});

test("refreshGeneratedTitle is a no-op for a design that doesn't exist", async () => {
  const { deps, written, prompts } = stubDeps("Keep diagrams fresh");
  assert.equal(await refreshGeneratedTitle(deps, "nope"), "no_such_design");
  assert.equal(prompts.length, 0);
  assert.deepEqual(written, []);
});
