import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  proposeGroupOverview,
  proposeOverviewForMembers,
  GroupResynthesisQueue,
  __clearGroupProposalCache,
  type GroupResynthesisDeps,
} from "./group-overview-resynthesis.js";
import type { DesignStatement } from "@twing/core";

beforeEach(() => __clearGroupProposalCache());

function design(overrides: Partial<DesignStatement> = {}): DesignStatement {
  return {
    id: "d1",
    groupId: "g1",
    projectId: "p1",
    developerId: "alice@example.com",
    sessionId: "s1",
    status: "open",
    createdAt: 1_000,
    summary: "What: adds a priority field.",
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
    overviewRevision: 0,
    ...overrides,
  } as DesignStatement;
}

function stubDeps(overrides: Partial<GroupResynthesisDeps> & { members?: DesignStatement[] } = {}) {
  const prompts: { system: string; user: string }[] = [];
  const logs: string[] = [];
  const members = overrides.members ?? [design({ id: "d1" }), design({ id: "d2", projectId: "p2" })];
  const deps: GroupResynthesisDeps = {
    listMembers: () => members,
    labelFor: (d) => d.projectId,
    callModel: async (system, user) => {
      prompts.push({ system, user });
      return "What: combined overview.";
    },
    log: (m) => logs.push(m),
    ...overrides,
  };
  return { deps, members, prompts, logs };
}

test("proposeGroupOverview: fewer than two members proposes nothing", async () => {
  const { deps } = stubDeps({ members: [design({ id: "d1" })] });
  const result = await proposeGroupOverview(deps, "g1");
  assert.equal(result, undefined);
});

test("proposeGroupOverview: two members produces one combined overview", async () => {
  const { deps, prompts } = stubDeps();
  const result = await proposeGroupOverview(deps, "g1");
  assert.equal(result, "What: combined overview.");
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].user, /REPO: p1/);
  assert.match(prompts[0].user, /REPO: p2/);
});

test("proposeGroupOverview: includes each member's grounding when available", async () => {
  const { deps } = stubDeps({
    groundingFor: (d) => (d.id === "d1" ? "the author hit a timeout at 10s and raised it to 30s" : undefined),
  });
  let capturedUser = "";
  const deps2: GroupResynthesisDeps = { ...deps, callModel: async (_s, u) => ((capturedUser = u), "ok") };
  await proposeGroupOverview(deps2, "g1");
  assert.match(capturedUser, /SESSION CONTEXT:\n.*timeout at 10s/s);
});

test("proposeGroupOverview: a model failure returns undefined rather than throwing", async () => {
  const { deps, logs } = stubDeps({ callModel: async () => { throw new Error("no provider"); } });
  const result = await proposeGroupOverview(deps, "g1");
  assert.equal(result, undefined);
  assert.equal(logs.length, 1);
});

test("proposeGroupOverview: an empty model answer is treated as no proposal", async () => {
  const { deps } = stubDeps({ callModel: async () => "   " });
  const result = await proposeGroupOverview(deps, "g1");
  assert.equal(result, undefined);
});

test("proposeGroupOverview: a second call for the same state costs no model call", async () => {
  const { deps, prompts } = stubDeps();
  await proposeGroupOverview(deps, "g1");
  await proposeGroupOverview(deps, "g1");
  assert.equal(prompts.length, 1);
});

test("proposeGroupOverview: a member amending invalidates the cache", async () => {
  const members = [design({ id: "d1", scopeVersion: 1 }), design({ id: "d2", projectId: "p2" })];
  const { deps, prompts } = stubDeps({ members });
  await proposeGroupOverview(deps, "g1");
  members[0].scopeVersion = 2; // simulates an amend on just one sibling
  await proposeGroupOverview(deps, "g1");
  assert.equal(prompts.length, 2);
});

test("proposeOverviewForMembers: a filtered (per-viewer) member list never consults a cache entry built from the full group", async () => {
  const full = [design({ id: "d1" }), design({ id: "d2", projectId: "p2" }), design({ id: "d3", projectId: "p3" })];
  const { deps, prompts } = stubDeps({ members: full });
  await proposeOverviewForMembers(deps, full); // the unfiltered background computation
  // A viewer who can't see p3 asks with only two members -- must not reuse
  // the three-member cache entry (which would leak p3's existence into
  // their answer) and must not even include it in the prompt.
  const filtered = full.filter((d) => d.projectId !== "p3");
  await proposeOverviewForMembers(deps, filtered);
  assert.equal(prompts.length, 2);
  assert.doesNotMatch(prompts[1].user, /p3/);
});

test("proposeGroupOverview: a human override short-circuits, no model call", async () => {
  const { deps, prompts } = stubDeps({ getOverride: (groupId) => (groupId === "g1" ? "Human-written combined overview." : undefined) });
  const result = await proposeGroupOverview(deps, "g1");
  assert.equal(result, "Human-written combined overview.");
  assert.equal(prompts.length, 0);
});

test("proposeOverviewForMembers: a human override short-circuits too, even called with members directly", async () => {
  const { deps, members, prompts } = stubDeps({ getOverride: () => "Human-written combined overview." });
  const result = await proposeOverviewForMembers(deps, members);
  assert.equal(result, "Human-written combined overview.");
  assert.equal(prompts.length, 0);
});

test("proposeGroupOverview: no override falls through to the model as before", async () => {
  const { deps, prompts } = stubDeps({ getOverride: () => undefined });
  const result = await proposeGroupOverview(deps, "g1");
  assert.equal(result, "What: combined overview.");
  assert.equal(prompts.length, 1);
});

test("GroupResynthesisQueue: coalesces a burst into one run", async () => {
  const { deps, prompts } = stubDeps();
  const queue = new GroupResynthesisQueue(deps, 10);
  queue.enqueue("g1");
  queue.enqueue("g1");
  queue.enqueue("g1");
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(prompts.length, 1);
  queue.clear();
});
