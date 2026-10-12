import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { DesignStatement } from "@twing/core";
import {
  worthConsidering,
  parseDecision,
  validateMermaid,
  diagramsForMembers,
  repairDiagram,
  buildDiagramContext,
  checkAuthorDiagrams,
  diagramsFromPlanText,
  __clearDiagramCache,
  type DiagramDeps,
} from "./design-diagrams.js";
import type { LlmTag } from "./llm-client.js";

beforeEach(() => __clearDiagramCache());

function design(overrides: Partial<DesignStatement> = {}): DesignStatement {
  return {
    id: "d1",
    groupId: "g1",
    projectId: "p1",
    developerId: "alice@example.com",
    sessionId: "s1",
    status: "open",
    createdAt: 1_000,
    summary: "Problem: no logs.\nApproach: log every call.",
    rawPlanExcerpt: "Middleware logs requests; the LLM client logs prompts.",
    creates: [],
    touches: [],
    dependsOn: [],
    changes: [
      { id: "c1", action: "modify", kind: "code", target: "src/app.ts", intent: "request middleware" },
      { id: "c2", action: "modify", kind: "code", target: "src/llm.ts", intent: "log prompts" },
    ],
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

const FLOW = "flowchart LR\n  a[Request] --> b[Middleware]\n  b --> c[Log file]";
const SEQUENCE = "sequenceDiagram\n  participant C as CLI\n  participant S as Server\n  C->>S: register\n  S-->>C: verdict";

/** A model stub: the decision call gets `decision`, generate calls are
 * answered per kind from `drawings` (a queue, so retries can differ). */
function stubDeps(decision: string, drawings: Partial<Record<string, string[]>> = {}) {
  const calls: { purpose: string; user: string; tag: LlmTag }[] = [];
  const deps: DiagramDeps = {
    labelFor: (d) => d.projectId,
    callModel: async (_system, user, tag) => {
      calls.push({ purpose: tag.purpose, user, tag });
      if (tag.purpose === "diagram_decision") return decision;
      const kind = /DIAGRAM KIND: (\w+)/.exec(user)![1];
      const queue = drawings[kind] ?? [];
      return queue.length > 1 ? queue.shift()! : (queue[0] ?? "");
    },
  };
  return { deps, calls };
}

// --- rules -------------------------------------------------------------------

test("worthConsidering: a single-file design never gets a diagram", () => {
  assert.equal(worthConsidering([design({ changes: [{ id: "c1", action: "modify", kind: "code", target: "src/a.ts::f", intent: "x" }] })]), false);
});

test("worthConsidering: a docs/test/config-only design never gets a diagram", () => {
  const changes = [
    { id: "c1", action: "modify" as const, kind: "docs" as const, target: "README.md", intent: "x" },
    { id: "c2", action: "modify" as const, kind: "test" as const, target: "a.test.ts", intent: "y" },
  ];
  assert.equal(worthConsidering([design({ changes })]), false);
});

test("worthConsidering: several code files, or several linked designs, qualify", () => {
  assert.equal(worthConsidering([design()]), true);
  const oneFile = { changes: [{ id: "c1", action: "modify" as const, kind: "code" as const, target: "src/a.ts", intent: "x" }] };
  assert.equal(worthConsidering([design(oneFile), design({ ...oneFile, id: "d2", projectId: "p2" })]), true);
});

// --- parsing and validation --------------------------------------------------

test("parseDecision: keeps valid distinct kinds, at most 3, and tolerates fences", () => {
  const reply = '```json\n{"diagrams":[{"type":"flow","reason":"r1"},{"type":"flow","reason":"dup"},{"type":"bogus"},{"type":"sequence","reason":"r2"}]}\n```';
  assert.deepEqual(parseDecision(reply), [
    { type: "flow", reason: "r1" },
    { type: "sequence", reason: "r2" },
  ]);
  assert.deepEqual(parseDecision('{"diagrams":[]}'), []);
  assert.equal(parseDecision("not json"), undefined);
});

test("validateMermaid: accepts a clean diagram and strips a mermaid fence", () => {
  assert.deepEqual(validateMermaid("flow", "```mermaid\n" + FLOW + "\n```"), { ok: true, mermaid: FLOW });
});

test("validateMermaid: rejects the wrong header, styling/links/HTML, and oversized diagrams", () => {
  assert.equal(validateMermaid("sequence", FLOW).ok, false);
  assert.equal(validateMermaid("flow", FLOW + "\n  click a href").ok, false);
  assert.equal(validateMermaid("flow", FLOW + "\n  style a fill:#f00").ok, false);
  assert.equal(validateMermaid("flow", "flowchart LR\n  a[<b>x</b>] --> b[y]").ok, false);
  const big = "flowchart LR\n" + Array.from({ length: 16 }, (_, i) => `  n${i}[Box ${i}] --> n${i + 1}[Box ${i + 1}]`).join("\n");
  assert.match((validateMermaid("flow", big) as { error: string }).error, /too many boxes/);
});

// --- the pipeline ------------------------------------------------------------

test("diagramsForMembers: rule-skipped designs make no model call", async () => {
  const { deps, calls } = stubDeps('{"diagrams":[{"type":"flow","reason":"r"}]}');
  const single = design({ changes: [{ id: "c1", action: "modify", kind: "code", target: "src/a.ts", intent: "x" }] });
  assert.deepEqual(await diagramsForMembers(deps, [single]), []);
  assert.equal(calls.length, 0);
});

test("diagramsForMembers: decides, draws each chosen kind, tags the calls, and caches", async () => {
  const { deps, calls } = stubDeps('{"diagrams":[{"type":"flow","reason":"moves data"},{"type":"sequence","reason":"calls"}]}', {
    flow: [FLOW],
    sequence: [SEQUENCE],
  });
  const result = await diagramsForMembers(deps, [design()]);
  assert.deepEqual(result.map((d) => [d.type, d.title]), [["flow", "Flow"], ["sequence", "Sequence (UML)"]]);
  assert.deepEqual(calls.map((c) => c.purpose), ["diagram_decision", "diagram_generate", "diagram_generate"]);
  assert.equal(calls[0].tag.groupId, "g1");
  assert.deepEqual(calls[0].tag.designIds, ["d1"]);
  // Second read of the same state: no further calls.
  await diagramsForMembers(deps, [design()]);
  assert.equal(calls.length, 3);
});

test("diagramsForMembers: an amendment (new scopeVersion) recomputes", async () => {
  const { deps, calls } = stubDeps('{"diagrams":[{"type":"flow","reason":"r"}]}', { flow: [FLOW] });
  await diagramsForMembers(deps, [design()]);
  await diagramsForMembers(deps, [design({ scopeVersion: 2 })]);
  assert.equal(calls.filter((c) => c.purpose === "diagram_decision").length, 2);
});

test("diagramsForMembers: a rejected drawing is retried once with the reason, then dropped", async () => {
  const { deps, calls } = stubDeps('{"diagrams":[{"type":"flow","reason":"r"},{"type":"sequence","reason":"s"}]}', {
    flow: ["graph nonsense", FLOW],
    sequence: ["bad", "still bad"],
  });
  const result = await diagramsForMembers(deps, [design()]);
  assert.deepEqual(result.map((d) => d.type), ["flow"]);
  const retry = calls.filter((c) => c.purpose === "diagram_generate" && c.user.includes("DIAGRAM KIND: flow"))[1];
  assert.match(retry.user, /YOUR PREVIOUS ATTEMPT WAS REJECTED: must start with `flowchart LR`/);
});

test("diagramsForMembers: a failed decision means no diagrams, not an error", async () => {
  const { deps } = stubDeps("I think a flow chart would be nice");
  assert.deepEqual(await diagramsForMembers(deps, [design()]), []);
});

test("diagramsForMembers: concurrent requests share one computation", async () => {
  const { deps, calls } = stubDeps('{"diagrams":[{"type":"flow","reason":"r"}]}', { flow: [FLOW] });
  await Promise.all([diagramsForMembers(deps, [design()]), diagramsForMembers(deps, [design()])]);
  assert.equal(calls.filter((c) => c.purpose === "diagram_decision").length, 1);
});

// --- repair ------------------------------------------------------------------

test("repairDiagram: regenerates once with the browser's error, then gives up and drops it", async () => {
  const FIXED = "flowchart LR\n  a[Request] --> b[Log]";
  const { deps, calls } = stubDeps('{"diagrams":[{"type":"flow","reason":"r"}]}', { flow: [FLOW, FIXED] });
  await diagramsForMembers(deps, [design()]);
  const fixed = await repairDiagram(deps, [design()], "flow", "Parse error on line 2");
  assert.equal(fixed?.mermaid, FIXED);
  assert.match(calls.at(-1)!.user, /REJECTED: Parse error on line 2/);
  assert.equal((await diagramsForMembers(deps, [design()]))[0].mermaid, FIXED);
  // A second failure on the same state is not paid for again; the kind goes.
  const before = calls.length;
  assert.equal(await repairDiagram(deps, [design()], "flow", "still broken"), undefined);
  assert.equal(calls.length, before);
  assert.deepEqual(await diagramsForMembers(deps, [design()]), []);
});

test("buildDiagramContext: one block per repo with overview, plan and changes", () => {
  const { deps } = stubDeps("");
  const context = buildDiagramContext(deps, [design(), design({ id: "d2", projectId: "p2", rawPlanExcerpt: undefined, changes: [] })]);
  assert.match(context, /REPO: p1\n\nOVERVIEW:\nProblem: no logs\./);
  assert.match(context, /PLAN:\nMiddleware logs requests/);
  assert.match(context, /- modify src\/app\.ts: request middleware/);
  assert.match(context, /---\n\nREPO: p2/);
});

// --- author-drawn diagrams (2026-10-11) ---------------------------------------

test("checkAuthorDiagrams: keeps valid ones, drops invalid or duplicate ones with a reason", () => {
  const { kept, warnings } = checkAuthorDiagrams([
    { type: "flow", mermaid: FLOW },
    { type: "flow", mermaid: FLOW },
    { type: "sequence", mermaid: "flowchart LR\n  a[A] --> b[B]" },
    { type: "pie", mermaid: "pie" },
  ]);
  assert.deepEqual(kept, [{ type: "flow", mermaid: FLOW }]);
  assert.equal(warnings.length, 3);
  assert.match(warnings[1], /dropped the sequence diagram: must start with `sequenceDiagram`/);
});

test("diagramsFromPlanText: pulls valid ```mermaid blocks out of a plan, typed by their first line", () => {
  const plan = ["## Approach", "Some prose.", "```mermaid", SEQUENCE, "```", "", "```mermaid", "pie title nope", "```", "```js", "flowchart LR", "```"].join("\n");
  assert.deepEqual(diagramsFromPlanText(plan), [{ type: "sequence", mermaid: SEQUENCE }]);
  assert.deepEqual(diagramsFromPlanText(undefined), []);
});

test("diagramsForMembers: the author's diagrams win, with no model call at all", async () => {
  const { deps, calls } = stubDeps('{"diagrams":[{"type":"flow","reason":"r"}]}', { flow: [FLOW] });
  const result = await diagramsForMembers(deps, [design({ authorDiagrams: [{ type: "sequence", mermaid: SEQUENCE }] })]);
  assert.deepEqual(result.map((d) => [d.source, d.type, d.title]), [["author", "sequence", "Sequence (UML)"]]);
  assert.equal(calls.length, 0);
});

test("diagramsForMembers: in a linked group, each author diagram is labelled with its repo", async () => {
  const { deps } = stubDeps("");
  const result = await diagramsForMembers(deps, [
    design({ authorDiagrams: [{ type: "flow", mermaid: FLOW }] }),
    design({ id: "d2", projectId: "p2", authorDiagrams: [{ type: "flow", mermaid: FLOW }] }),
  ]);
  assert.deepEqual(result.map((d) => [d.id, d.title]), [["author:d1:flow", "Flow · p1"], ["author:d2:flow", "Flow · p2"]]);
});

test("diagramsForMembers: generated diagrams say so", async () => {
  const { deps } = stubDeps('{"diagrams":[{"type":"flow","reason":"r"}]}', { flow: [FLOW] });
  const [only] = await diagramsForMembers(deps, [design()]);
  assert.equal(only.source, "generated");
  assert.equal(only.id, "generated:flow");
});
