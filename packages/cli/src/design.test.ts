/**
 * `twing design *` (design.ts) end-to-end at the function boundary --
 * previously packages/cli had zero test files for any subcommand. Fixture
 * helpers live in `test-support.ts`, shared with the rest of packages/cli's
 * suites; see that file's header comment for the conventions they mirror.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  runDesignRegister,
  runDesignResolve,
  runDesignAmend,
  runDesignResume,
  runDesignList,
  runDesignReviews,
  runDesignEnableGate,
  runDesignDisableGate,
} from "./design.js";
import { tmpRepo, withHome, cacheToken, withMockFetch, withEnv, captureConsole, jsonResponse, captureFetch } from "./test-support.js";

const SERVER_URL = "http://localhost:9999";

// --- runDesignRegister ------------------------------------------------------

test("runDesignRegister: sends the right body and prints a clean verdict", async () => {
  const { fetch, calls } = captureFetch(jsonResponse({ verdict: "clean", designId: "d1" }));
  await withHome(async () => {
    cacheToken(SERVER_URL, "test-token");
    const repo = tmpRepo(SERVER_URL);
    const { logs } = await captureConsole(() =>
      withMockFetch(fetch, () =>
        runDesignRegister({ cwd: repo, session: "sess1", summary: "does a thing", creates: "Foo,Bar", touches: "a.ts", dependsOn: "Baz" }),
      ),
    );
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/v1\/designs\/check$/);
    const body = calls[0].body as Record<string, unknown>;
    assert.equal(typeof body.projectId, "string");
    assert.equal(typeof body.developerId, "string");
    assert.equal(body.sessionId, "sess1");
    assert.equal(body.agentLabel, undefined);
    assert.equal(body.summary, "does a thing");
    assert.deepEqual(body.creates, ["Foo", "Bar"]);
    assert.deepEqual(body.touches, ["a.ts"]);
    assert.deepEqual(body.dependsOn, ["Baz"]);
    assert.ok(logs.some((l) => l.includes("verdict: clean") && l.includes("d1")));
  });
});

test("runDesignRegister: falls back to CLAUDE_CODE_SESSION_ID when --session is omitted", async () => {
  const { fetch, calls } = captureFetch(jsonResponse({ verdict: "clean", designId: "d1" }));
  await withHome(async () => {
    cacheToken(SERVER_URL, "test-token");
    const repo = tmpRepo(SERVER_URL);
    await withEnv({ CLAUDE_CODE_SESSION_ID: "env-session" }, () =>
      withMockFetch(fetch, () => runDesignRegister({ cwd: repo, summary: "" })),
    );
    assert.equal((calls[0].body as { sessionId: string }).sessionId, "env-session");
  });
});

test("runDesignRegister: throws when neither --session nor CLAUDE_CODE_SESSION_ID is available", async () => {
  await withHome(async () => {
    cacheToken(SERVER_URL, "test-token");
    const repo = tmpRepo(SERVER_URL);
    await withEnv({ CLAUDE_CODE_SESSION_ID: undefined }, async () => {
      await assert.rejects(() => runDesignRegister({ cwd: repo, summary: "" }), /no session id/);
    });
  });
});

test("runDesignRegister: throws when the repo has no coordinator configured", async () => {
  await withHome(async () => {
    const repo = tmpRepo(); // no .twing/twing.yml at all
    await assert.rejects(() => runDesignRegister({ cwd: repo, session: "s1", summary: "" }), /no coordinator configured/);
  });
});

test("runDesignRegister: a 401 response prints the unauthorized hint instead of a verdict", async () => {
  const { fetch } = captureFetch(jsonResponse({ error: "unauthorized" }, 401));
  await withHome(async () => {
    cacheToken(SERVER_URL, "stale-token");
    const repo = tmpRepo(SERVER_URL);
    const { errors } = await captureConsole(() => withMockFetch(fetch, () => runDesignRegister({ cwd: repo, session: "s1", summary: "" })));
    assert.ok(errors.some((e) => e.includes("unauthorized") && e.includes("twing login")));
  });
});

// --- runDesignResolve --------------------------------------------------------

test("runDesignResolve: --adopt sends resolution: adopted", async () => {
  const { fetch, calls } = captureFetch(jsonResponse({ status: "superseded" }));
  await withHome(async () => {
    cacheToken(SERVER_URL, "test-token");
    const repo = tmpRepo(SERVER_URL);
    await withMockFetch(fetch, () => runDesignResolve({ cwd: repo, id: "d1", adopt: "d2" }));
    assert.match(calls[0].url, /\/v1\/designs\/d1\/resolve$/);
    assert.deepEqual(calls[0].body, { resolution: "adopted", adoptedDesignId: "d2" });
  });
});

test("runDesignResolve: --justify sends resolution: justified_divergence", async () => {
  const { fetch, calls } = captureFetch(jsonResponse({ status: "pending_review", reviewId: "r1" }));
  await withHome(async () => {
    cacheToken(SERVER_URL, "test-token");
    const repo = tmpRepo(SERVER_URL);
    await withMockFetch(fetch, () => runDesignResolve({ cwd: repo, id: "d1", justify: "intentional" }));
    assert.deepEqual(calls[0].body, { resolution: "justified_divergence", justification: "intentional" });
  });
});

test("runDesignResolve: throws without --id, or without --adopt/--justify", async () => {
  await withHome(async () => {
    cacheToken(SERVER_URL, "test-token");
    const repo = tmpRepo(SERVER_URL);
    await assert.rejects(() => runDesignResolve({ cwd: repo, adopt: "d2" }), /--id/);
    await assert.rejects(() => runDesignResolve({ cwd: repo, id: "d1" }), /--adopt.*--justify/);
  });
});

// --- runDesignAmend -----------------------------------------------------------

test("runDesignAmend: sends the split scope delta and prints conflict detail on overlap", async () => {
  const { fetch, calls } = captureFetch(
    jsonResponse({
      verdict: "overlap",
      designId: "d1",
      conflicts: [{ conflictingDesignId: "d2", overlapKind: "touches", overlapDetail: "both touch b.ts", conflictingSummary: "someone else's work" }],
    }),
  );
  await withHome(async () => {
    cacheToken(SERVER_URL, "test-token");
    const repo = tmpRepo(SERVER_URL);
    const { logs } = await captureConsole(() => withMockFetch(fetch, () => runDesignAmend({ cwd: repo, id: "d1", touches: "b.ts,c.ts" })));
    assert.match(calls[0].url, /\/v1\/designs\/d1\/amend$/);
    assert.deepEqual(calls[0].body, { addTouches: ["b.ts", "c.ts"], addCreates: [], addDependsOn: [] });
    assert.ok(logs.some((l) => l.includes("touches") && l.includes("d2")));
    assert.ok(logs.some((l) => l.includes("someone else's work")));
  });
});

test("runDesignAmend: throws without --id, or without any of --touches/--creates/--depends-on", async () => {
  await withHome(async () => {
    cacheToken(SERVER_URL, "test-token");
    const repo = tmpRepo(SERVER_URL);
    await assert.rejects(() => runDesignAmend({ cwd: repo, touches: "a.ts" }), /--id/);
    await assert.rejects(() => runDesignAmend({ cwd: repo, id: "d1" }), /--touches.*--creates.*--depends-on/);
  });
});

// --- runDesignResume ----------------------------------------------------------

test("runDesignResume: sends sessionId plus the split scope delta", async () => {
  const { fetch, calls } = captureFetch(jsonResponse({ verdict: "clean", designId: "d1" }));
  await withHome(async () => {
    cacheToken(SERVER_URL, "test-token");
    const repo = tmpRepo(SERVER_URL);
    const { logs } = await captureConsole(() =>
      withMockFetch(fetch, () => runDesignResume({ cwd: repo, id: "d1", session: "s-bob", touches: "b.ts" })),
    );
    assert.match(calls[0].url, /\/v1\/designs\/d1\/resume$/);
    assert.deepEqual(calls[0].body, { sessionId: "s-bob", addTouches: ["b.ts"], addCreates: [], addDependsOn: [] });
    assert.ok(logs.some((l) => l.includes("verdict: clean")));
  });
});

test("runDesignResume: throws without --id, or without a resolvable session", async () => {
  await withHome(async () => {
    cacheToken(SERVER_URL, "test-token");
    const repo = tmpRepo(SERVER_URL);
    await assert.rejects(() => runDesignResume({ cwd: repo, session: "s1" }), /--id/);
    await withEnv({ CLAUDE_CODE_SESSION_ID: undefined }, async () => {
      await assert.rejects(() => runDesignResume({ cwd: repo, id: "d1" }), /no session id/);
    });
  });
});

// --- runDesignList --------------------------------------------------------------

test("runDesignList: appends ?status= and prints last-activity staleness", async () => {
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  const { fetch, calls } = captureFetch(
    jsonResponse({ items: [{ id: "d1", status: "dormant", summary: "old work", creates: [], touches: ["a.ts"], lastActivityAt: twoHoursAgo }] }),
  );
  await withHome(async () => {
    cacheToken(SERVER_URL, "test-token");
    const repo = tmpRepo(SERVER_URL);
    const { logs } = await captureConsole(() => withMockFetch(fetch, () => runDesignList({ cwd: repo, status: "dormant" })));
    assert.match(calls[0].url, /[?&]status=dormant/);
    assert.ok(logs.some((l) => l.includes("[dormant]") && l.includes("last activity 2h ago") && l.includes("old work")));
  });
});

// --- runDesignReviews -----------------------------------------------------------

test("runDesignReviews: lists pending reviews", async () => {
  const { fetch } = captureFetch(jsonResponse({ items: [{ id: "r1", designId: "d1", justification: "intentional, reviewed" }] }));
  await withHome(async () => {
    cacheToken(SERVER_URL, "test-token");
    const repo = tmpRepo(SERVER_URL);
    const { logs } = await captureConsole(() => withMockFetch(fetch, () => runDesignReviews({ cwd: repo })));
    assert.ok(logs.some((l) => l.includes("r1") && l.includes("d1") && l.includes("intentional, reviewed")));
  });
});

test("runDesignReviews: --decide sends the decision", async () => {
  const { fetch, calls } = captureFetch(jsonResponse({ review: { id: "r1", decision: "approve" } }));
  await withHome(async () => {
    cacheToken(SERVER_URL, "test-token");
    const repo = tmpRepo(SERVER_URL);
    await withMockFetch(fetch, () => runDesignReviews({ cwd: repo, decide: "r1", decision: "approve" }));
    assert.match(calls[0].url, /\/v1\/reviews\/r1\/decide$/);
    assert.deepEqual(calls[0].body, { decision: "approve" });
  });
});

test("runDesignReviews: --decide without --decision throws", async () => {
  await withHome(async () => {
    cacheToken(SERVER_URL, "test-token");
    const repo = tmpRepo(SERVER_URL);
    await assert.rejects(() => runDesignReviews({ cwd: repo, decide: "r1" }), /--decision approve\|reject/);
  });
});

// --- runDesignEnableGate / runDesignDisableGate (wire-hooks.ts's design-gate entries) ---

test("runDesignEnableGate: wires the design-gate hooks into .claude/settings.json, then reports already-wired on a second call", async () => {
  await withHome(async () => {
    const repo = tmpRepo();
    const { logs: first } = await captureConsole(() => Promise.resolve(runDesignEnableGate({ cwd: repo })));
    assert.ok(first.some((l) => l.includes("wired into") && l.includes("settings.json")));

    const settings = JSON.parse(fs.readFileSync(path.join(repo, ".claude", "settings.json"), "utf8")) as { hooks?: { PreToolUse?: unknown[] } };
    assert.equal(settings.hooks?.PreToolUse?.length, 2);

    const { logs: second } = await captureConsole(() => Promise.resolve(runDesignEnableGate({ cwd: repo })));
    assert.ok(second.some((l) => l.includes("already wired")));
  });
});

test("runDesignDisableGate: unwires the design-gate hooks, then reports it wasn't wired on a second call", async () => {
  await withHome(async () => {
    const repo = tmpRepo();
    runDesignEnableGate({ cwd: repo });

    const { logs: first } = await captureConsole(() => Promise.resolve(runDesignDisableGate({ cwd: repo })));
    assert.ok(first.some((l) => l.includes("removed from") && l.includes("settings.json")));

    const settings = JSON.parse(fs.readFileSync(path.join(repo, ".claude", "settings.json"), "utf8")) as { hooks?: { PreToolUse?: unknown[] } };
    assert.deepEqual(settings.hooks?.PreToolUse, []);

    const { logs: second } = await captureConsole(() => Promise.resolve(runDesignDisableGate({ cwd: repo })));
    assert.ok(second.some((l) => l.includes("wasn't wired")));
  });
});
