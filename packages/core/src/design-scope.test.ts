import test from "node:test";
import assert from "node:assert/strict";
import { parseDesignTemplate, validateTemplate, deriveScope, pathOfTarget, suggestAction, DESIGN_CHANGE_ACTIONS } from "./design-scope.js";
import { computeSymbolId } from "./symbol-id.js";
import type { DesignChange } from "./types.js";

function change(over: Partial<DesignChange> = {}): DesignChange {
  return { id: "c1", action: "modify", target: "src/a.ts::A.b", intent: "does a thing", ...over };
}

// ---------------------------------------------------------------------------
// pathOfTarget -- the inverse of computeSymbolId
// ---------------------------------------------------------------------------

test("pathOfTarget strips the symbol suffix", () => {
  assert.equal(pathOfTarget("src/net/retry.ts::RetryPolicy.backoff"), "src/net/retry.ts");
});

test("pathOfTarget leaves a bare path alone", () => {
  assert.equal(pathOfTarget("src/net/retry.ts"), "src/net/retry.ts");
});

// The whole design rests on design targets and claim symbolIds sharing one
// namespace -- if computeSymbolId and pathOfTarget ever disagree, the set
// difference that makes conformance checkable silently stops matching.
test("pathOfTarget is the exact inverse of computeSymbolId", () => {
  for (const [path, scope] of [
    ["src/net/retry.ts", "RetryPolicy.backoff"],
    ["packages/core/src/identity.ts", "computeProjectId"],
    ["a.ts", null],
  ] as const) {
    assert.equal(pathOfTarget(computeSymbolId(path, scope)), path);
  }
});

// ---------------------------------------------------------------------------
// deriveScope
// ---------------------------------------------------------------------------

test("deriveScope: only `add` lands in creates, everything else in touches", () => {
  const { creates, touches } = deriveScope([
    change({ id: "c1", action: "add", target: "src/new.ts::New.thing" }),
    change({ id: "c2", action: "modify", target: "src/old.ts::Old.thing" }),
    change({ id: "c3", action: "remove", target: "src/gone.ts::Gone.thing" }),
  ]);
  assert.deepEqual(creates, ["src/new.ts"]);
  assert.deepEqual(touches, ["src/old.ts", "src/gone.ts"]);
});

test("deriveScope dedupes several changes targeting one file", () => {
  const { touches } = deriveScope([
    change({ id: "c1", target: "src/retry.ts::A.one" }),
    change({ id: "c2", target: "src/retry.ts::A.two" }),
    change({ id: "c3", target: "src/retry.ts::A.three" }),
  ]);
  assert.deepEqual(touches, ["src/retry.ts"]);
});

test("deriveScope skips an empty target rather than emitting an empty path", () => {
  const { creates, touches } = deriveScope([change({ target: "" })]);
  assert.deepEqual(creates, []);
  assert.deepEqual(touches, []);
});

test("deriveScope on an empty list is empty, not undefined", () => {
  assert.deepEqual(deriveScope([]), { creates: [], touches: [] });
});

// ---------------------------------------------------------------------------
// parseDesignTemplate -- never throws
// ---------------------------------------------------------------------------

test("parseDesignTemplate reads goal and changes", () => {
  const t = parseDesignTemplate(`
goal: "survive transient failures"
changes:
  - id: c1
    action: modify
    target: src/net/retry.ts::RetryPolicy.backoff
    intent: "capped exponential growth"
`);
  assert.equal(t.goal, "survive transient failures");
  assert.equal(t.changes.length, 1);
  assert.deepEqual(t.changes[0], {
    id: "c1",
    action: "modify",
    target: "src/net/retry.ts::RetryPolicy.backoff",
    intent: "capped exponential growth",
  });
});

test("parseDesignTemplate keeps `from` when present and omits it otherwise", () => {
  const t = parseDesignTemplate(`
goal: g
changes:
  - id: c1
    action: rename
    target: src/a.ts::A.next
    from: A.prev
    intent: i
  - id: c2
    action: modify
    target: src/a.ts::A.other
    intent: i
`);
  assert.equal(t.changes[0].from, "A.prev");
  assert.ok(!("from" in t.changes[1]));
});

test("parseDesignTemplate returns an empty template for malformed YAML rather than throwing", () => {
  assert.deepEqual(parseDesignTemplate("goal: [unclosed"), { goal: "", changes: [] });
});

test("parseDesignTemplate tolerates a scalar document", () => {
  assert.deepEqual(parseDesignTemplate("just a string"), { goal: "", changes: [] });
});

test("parseDesignTemplate falls back to a positional id so later messages can name the item", () => {
  const t = parseDesignTemplate(`
goal: g
changes:
  - action: modify
    target: src/a.ts
    intent: i
`);
  assert.equal(t.changes[0].id, "#1");
});

// ---------------------------------------------------------------------------
// validateTemplate -- reports everything, not just the first problem
// ---------------------------------------------------------------------------

test("validateTemplate accepts a well-formed template", () => {
  assert.deepEqual(validateTemplate({ goal: "g", changes: [change()] }), []);
});

test("validateTemplate flags a missing goal", () => {
  const problems = validateTemplate({ goal: "", changes: [change()] });
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /goal/);
});

test("validateTemplate flags an empty changes list", () => {
  const problems = validateTemplate({ goal: "g", changes: [] });
  assert.match(problems[0].message, /no `changes:`/);
});

test("validateTemplate rejects an unknown action and lists the valid ones", () => {
  const problems = validateTemplate({ goal: "g", changes: [change({ action: "refactor" as never })] });
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /unknown action "refactor"/);
  for (const action of DESIGN_CHANGE_ACTIONS) assert.match(problems[0].message, new RegExp(action));
});

test("validateTemplate flags duplicate ids", () => {
  const problems = validateTemplate({ goal: "g", changes: [change({ id: "c1" }), change({ id: "c1" })] });
  assert.equal(problems.filter((p) => /duplicate id/.test(p.message)).length, 1);
});

test("validateTemplate requires `from` on rename and on move", () => {
  for (const action of ["rename", "move"] as const) {
    const problems = validateTemplate({ goal: "g", changes: [change({ action })] });
    assert.equal(problems.length, 1, `${action} should need from`);
    assert.match(problems[0].message, /needs `from:`/);
  }
});

test("validateTemplate rejects `from` on an action that isn't rename/move", () => {
  const problems = validateTemplate({ goal: "g", changes: [change({ action: "modify", from: "Old.name" })] });
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /only applies to rename\/move/);
});

test("validateTemplate does not also complain about `from` when the action is already invalid", () => {
  // Otherwise a single typo produces two errors, the second of which is
  // noise -- the author needs to fix the action, not remove `from`.
  const problems = validateTemplate({ goal: "g", changes: [change({ action: "renam" as never, from: "A.prev" })] });
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /unknown action/);
});

test("validateTemplate reports every problem at once, not just the first", () => {
  const problems = validateTemplate({
    goal: "",
    changes: [change({ id: "c1", action: "" as never, target: "", intent: "" })],
  });
  // missing goal + missing action + missing target + missing intent
  assert.equal(problems.length, 4);
});

test("validateTemplate attributes per-change problems to the change id", () => {
  const problems = validateTemplate({ goal: "g", changes: [change({ id: "c7", intent: "" })] });
  assert.equal(problems[0].changeId, "c7");
});

// ---------------------------------------------------------------------------
// suggestAction
// ---------------------------------------------------------------------------

test("suggestAction catches the realistic tense mistakes", () => {
  assert.equal(suggestAction("renamed"), "rename");
  assert.equal(suggestAction("moved"), "move");
  assert.equal(suggestAction("added"), "add");
  assert.equal(suggestAction("modif"), "modify");
});

test("suggestAction returns undefined when nothing is close", () => {
  assert.equal(suggestAction("refactor"), undefined);
  assert.equal(suggestAction(""), undefined);
});
