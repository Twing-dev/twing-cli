import { test } from "node:test";
import assert from "node:assert/strict";
import type { Claim, DesignStatement } from "@twing/core";
import { runDesignDivergenceChecks } from "./design-divergence.js";

function makeClaim(overrides: Partial<Claim> = {}): Claim {
  return {
    projectId: "p1",
    developerId: "alice",
    sessionId: "s-alice",
    branch: "main",
    symbolId: "src/net/retry.ts::RetryPolicy.backoff",
    kind: "write",
    stage: "firm",
    ts: 100,
    ttlMs: 6 * 60 * 60 * 1000,
    ...overrides,
  };
}

function makeDesign(overrides: Partial<DesignStatement> = {}): DesignStatement {
  return {
    id: "d1",
    projectId: "p1",
    developerId: "bob",
    sessionId: "s-bob",
    status: "open",
    createdAt: 0,
    summary: "bob's retry work",
    creates: [],
    touches: [],
    dependsOn: [],
    ttlMs: 24 * 60 * 60 * 1000,
    ...overrides,
  };
}

test("runDesignDivergenceChecks: matches on the claim's file-path prefix in another design's touches", () => {
  const claim = makeClaim();
  const design = makeDesign({ touches: ["src/net/retry.ts"] });
  const findings = runDesignDivergenceChecks([claim], [design]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "design_divergence");
  assert.equal(findings[0].developerId, "alice");
  assert.equal(findings[0].otherDeveloperId, "bob");
});

test("runDesignDivergenceChecks: matches on a glob in creates", () => {
  const claim = makeClaim({ symbolId: "src/net/backoff.ts::compute" });
  const design = makeDesign({ creates: ["src/net/*.ts"] });
  const findings = runDesignDivergenceChecks([claim], [design]);
  assert.equal(findings.length, 1);
});

test("runDesignDivergenceChecks: excludes designs from the same session", () => {
  const claim = makeClaim({ sessionId: "same-session" });
  const design = makeDesign({ sessionId: "same-session", touches: ["src/net/retry.ts"] });
  assert.equal(runDesignDivergenceChecks([claim], [design]).length, 0);
});

test("runDesignDivergenceChecks: no finding when nothing overlaps", () => {
  const claim = makeClaim();
  const design = makeDesign({ touches: ["completely/unrelated.ts"] });
  assert.equal(runDesignDivergenceChecks([claim], [design]).length, 0);
});

test("runDesignDivergenceChecks: multiple open designs produce multiple findings", () => {
  const claim = makeClaim();
  const designA = makeDesign({ id: "dA", developerId: "bob", sessionId: "s-bob", touches: ["src/net/retry.ts"] });
  const designB = makeDesign({ id: "dB", developerId: "carol", sessionId: "s-carol", creates: ["src/net/retry.ts"] });
  const findings = runDesignDivergenceChecks([claim], [designA, designB]);
  assert.equal(findings.length, 2);
  assert.deepEqual(
    findings.map((f) => f.otherDeveloperId).sort(),
    ["bob", "carol"],
  );
});

test("runDesignDivergenceChecks: same-developer's own concurrent session still catches divergence (matches checks.ts convention)", () => {
  const claim = makeClaim({ developerId: "alice", sessionId: "s-alice-1" });
  const design = makeDesign({ developerId: "alice", sessionId: "s-alice-2", touches: ["src/net/retry.ts"] });
  const findings = runDesignDivergenceChecks([claim], [design]);
  assert.equal(findings.length, 1);
});
