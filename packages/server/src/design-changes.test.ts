import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveScope } from "@twing/core";
import { ensureChanges, mergeChanges, inferKind, DERIVED_INTENT_PREFIX } from "./design-changes.js";

// The invariant this module exists for. Structured templates shipped
// reaching only `register --from`; every other path produced a design with
// no `changes` at all. These tests are written against the *guarantee*
// ("scope in, changes out"), not against the derivation's current shape,
// so they keep holding if the inference gets smarter.

test("ensureChanges: any declared scope produces changes, with no client support at all", () => {
  // The plan-mode / old-CLI / LLM-outage case: nothing but paths.
  const changes = ensureChanges({ creates: ["src/new.ts"], touches: ["src/old.ts"], summary: "Do a thing" });
  assert.equal(changes.length, 2);
  assert.deepEqual(
    changes.map((c) => [c.action, c.target]),
    [
      ["add", "src/new.ts"],
      ["modify", "src/old.ts"],
    ],
  );
  for (const c of changes) {
    assert.ok(c.id.length > 0, "every change needs an id");
    assert.ok(c.kind, "every derived change carries a kind");
  }
});

test("ensureChanges: empty only when the design declares no scope whatsoever", () => {
  assert.deepEqual(ensureChanges({}), []);
  assert.deepEqual(ensureChanges({ creates: [], touches: [] }), []);
});

test("ensureChanges: a derived change says it was derived", () => {
  // The distinction a reviewer depends on: "the author declared this" vs
  // "we inferred it from a file list". Losing it would make the structured
  // view look more authoritative than the path list it replaced.
  const [change] = ensureChanges({ touches: ["src/a.ts"], summary: "Add retries" });
  assert.ok(change.intent.startsWith(DERIVED_INTENT_PREFIX));
  assert.ok(change.intent.includes("Add retries"), "the summary is carried into the intent");
});

test("ensureChanges: supplied changes win and are never overwritten by derivation", () => {
  const supplied = [{ id: "c1", action: "rewrite" as const, kind: "api" as const, target: "src/a.ts", intent: "authored" }];
  const changes = ensureChanges({ changes: supplied, creates: ["src/b.ts"], touches: ["src/c.ts"], summary: "x" });
  assert.deepEqual(changes, supplied, "declared intent must survive verbatim");
});

test("ensureChanges: a malformed item is dropped without losing the good ones", () => {
  // One bad item must not cost the other nine, and must not 400 a
  // registration -- this path can never block an edit.
  const changes = ensureChanges({
    changes: [
      { id: "c1", action: "modify", target: "src/a.ts", intent: "ok" },
      { id: "c2", action: "teleport", target: "src/b.ts", intent: "bogus action" },
      { nope: true },
    ],
  });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].target, "src/a.ts");
});

test("ensureChanges: an unknown kind is rejected rather than trusted", () => {
  const changes = ensureChanges({ changes: [{ id: "c1", action: "modify", kind: "wharrgarbl", target: "a.ts", intent: "i" }] });
  assert.deepEqual(changes, [], "an off-list kind makes the item invalid, not silently coerced");
});

test("ensureChanges: derivation round-trips back to the scope it came from", () => {
  // The symmetry that keeps the gate honest: deriving changes from a scope
  // and then deriving the scope back must not move any path between
  // creates and touches, or the design's declared scope would drift from
  // what the author actually wrote.
  const creates = ["a/new.ts", "b/also-new.ts"];
  const touches = ["c/existing.ts"];
  const back = deriveScope(ensureChanges({ creates, touches, summary: "s" }));
  assert.deepEqual(back.creates.sort(), [...creates].sort());
  assert.deepEqual(back.touches.sort(), [...touches].sort());
});

test("ensureChanges: a path in both creates and touches becomes one add, not two rows", () => {
  const changes = ensureChanges({ creates: ["src/a.ts"], touches: ["src/a.ts"], summary: "s" });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].action, "add");
});

test("inferKind: classifies by directory and by suffix", () => {
  const cases: [string, string][] = [
    ["packages/core/src/design-scope.test.ts", "test"],
    ["hook/design_gate_test.go", "test"],
    ["tests/helpers.ts", "test"],
    ["packages/server/drizzle/0016_x.sql", "schema"],
    ["packages/server/src/db/schema.ts", "schema"],
    ["docs/bugs.md", "docs"],
    ["README.md", "docs"],
    [".twing/twing.yml", "config"],
    ["package.json", "config"],
    ["src/routes/users.ts", "api"],
    ["src/user.controller.ts", "api"],
    ["packages/cli/src/design.ts", "code"],
  ];
  for (const [path, expected] of cases) {
    assert.equal(inferKind(path), expected, `${path} should be ${expected}`);
  }
});

test("inferKind: reads the path out of a symbol target", () => {
  // `target` may be `path::Symbol.method`; the kind comes from the path.
  assert.equal(inferKind("packages/server/src/db/schema.ts::designs"), "schema");
});

test("mergeChanges: existing declarations survive an amend verbatim and stay first", () => {
  const existing = [{ id: "c1", action: "modify" as const, kind: "code" as const, target: "src/a.ts", intent: "authored" }];
  const merged = mergeChanges(existing, { touches: ["src/b.ts"], summary: "s" });
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0], existing[0], "authored intent is never rewritten by an amend");
  assert.equal(merged[1].target, "src/b.ts");
});

test("mergeChanges: re-adding an already-declared path is a no-op", () => {
  // Amends repeat. A design whose scope is amended twice with the same
  // path must not accumulate duplicate rows.
  const existing = [{ id: "c1", action: "modify" as const, kind: "code" as const, target: "src/a.ts", intent: "authored" }];
  assert.deepEqual(mergeChanges(existing, { touches: ["src/a.ts"] }), existing);
});

test("mergeChanges: an incoming id that collides is renamed, not dropped or overwritten", () => {
  // A hand-written `amend --from` fragment cannot know which ids are
  // taken -- the deny message even tells the author to guess.
  const existing = [{ id: "c1", action: "modify" as const, kind: "code" as const, target: "src/a.ts", intent: "first" }];
  const merged = mergeChanges(existing, {
    changes: [{ id: "c1", action: "modify", kind: "code", target: "src/b.ts", intent: "second" }],
  });
  assert.equal(merged.length, 2);
  assert.equal(merged[0].id, "c1");
  assert.notEqual(merged[1].id, "c1", "the collision is resolved by renaming the newcomer");
  assert.equal(merged[1].target, "src/b.ts");
  assert.equal(merged[1].intent, "second", "the newcomer keeps its authored intent");
});

test("mergeChanges: amending a design that never had changes still produces them", () => {
  // Every design registered before this module existed has no `changes`.
  // The first amend is what backfills them -- without this, a pre-existing
  // design could never acquire a structured view at all.
  const merged = mergeChanges(undefined, { creates: ["src/new.ts"], summary: "s" });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].action, "add");
});
