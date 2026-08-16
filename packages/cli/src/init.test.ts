/**
 * `twing init` (init.ts) end-to-end at the function boundary. Fixture
 * helpers live in `test-support.ts` -- see that file's header comment.
 *
 * `runInit` is the one CLI command with real, unmockable-without-injection
 * side effects (a `go build` subprocess, spawning a detached daemon
 * process) -- `InitDeps` exists specifically so this file can stand those
 * up with fast, safe fakes instead. Real callers (`index.ts`'s dispatch)
 * never pass a second argument, so this changes nothing about production
 * behavior; see `init.ts`'s own comment on `InitDeps` for the reasoning.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { runInit, type InitDeps } from "./init.js";
import { tmpRepo, withHome, cacheToken, withMockFetch, captureConsole, jsonResponse, captureFetch, captureFetchSequence } from "./test-support.js";

const SERVER_URL = "http://localhost:9999";

function fakeDeps(overrides: Partial<InitDeps> = {}): {
  deps: InitDeps;
  calls: { wireHooks: { hookPath: string }[]; stripLegacyRepoLocalHooks: { repoRoot: string; hookPath: string }[] };
} {
  const calls = { wireHooks: [] as { hookPath: string }[], stripLegacyRepoLocalHooks: [] as { repoRoot: string; hookPath: string }[] };
  const deps: InitDeps = {
    ensureHookInstalled: async () => "/fake/bin/twing-hook",
    wireHooks: (hookPath) => {
      calls.wireHooks.push({ hookPath });
      return true;
    },
    stripLegacyRepoLocalHooks: (repoRoot, hookPath) => {
      calls.stripLegacyRepoLocalHooks.push({ repoRoot, hookPath });
      return false;
    },
    ensureDaemonRunning: async () => "started",
    installDaemonService: async () => "installed",
    ...overrides,
  };
  return { deps, calls };
}

test("runInit: full flow with an already-cached PAT -- resolves the server, installs/wires/starts, no invite redemption call", async () => {
  const { fetch, calls } = captureFetch(jsonResponse({}));
  const { deps, calls: depCalls } = fakeDeps();
  await withHome(async () => {
    cacheToken(SERVER_URL, "already-cached-pat");
    const repo = tmpRepo();
    const { logs } = await captureConsole(() => withMockFetch(fetch, () => runInit({ cwd: repo, server: SERVER_URL }, deps)));

    assert.equal(calls.length, 0, "no constraints/reviews to seed -- must not even attempt the seed call");
    assert.equal(depCalls.wireHooks.length, 1);
    assert.equal(depCalls.wireHooks[0].hookPath, "/fake/bin/twing-hook");
    assert.ok(logs.some((l) => l.includes(`server = ${SERVER_URL}`)));
    assert.ok(logs.some((l) => l.includes("wrote coordinator.serverUrl")));
    assert.ok(logs.some((l) => l.includes("hook installed at /fake/bin/twing-hook")));
    assert.ok(logs.some((l) => l.includes("wired hooks into")));
    assert.ok(logs.some((l) => l.includes("daemon started")));
    assert.ok(logs.some((l) => l.includes("daemon installed as a persistent OS-level service")));
    assert.ok(logs.some((l) => l.includes("twing init: done")));

    const manifest = fs.readFileSync(path.join(repo, ".twing", "twing.yml"), "utf8");
    assert.match(manifest, new RegExp(SERVER_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    assert.equal(depCalls.stripLegacyRepoLocalHooks.length, 1, "must always check for legacy repo-local entries, even when there's nothing to strip");
    assert.equal(depCalls.stripLegacyRepoLocalHooks[0].repoRoot, repo);
  });
});

test("runInit: reports when legacy repo-local hook entries were found and removed (upgrade migration)", async () => {
  const { fetch } = captureFetch(jsonResponse({}));
  const { deps } = fakeDeps({ stripLegacyRepoLocalHooks: () => true });
  await withHome(async () => {
    cacheToken(SERVER_URL, "already-cached-pat");
    const repo = tmpRepo();
    const { logs } = await captureConsole(() => withMockFetch(fetch, () => runInit({ cwd: repo, server: SERVER_URL }, deps)));
    assert.ok(logs.some((l) => l.includes("removed legacy repo-local hook entries")));
  });
});

test("runInit: a non-fatal OS-service install failure is logged but doesn't abort init", async () => {
  const { fetch } = captureFetch(jsonResponse({}));
  const { deps } = fakeDeps({ installDaemonService: async () => "failed" });
  await withHome(async () => {
    cacheToken(SERVER_URL, "already-cached-pat");
    const repo = tmpRepo();
    const { logs } = await captureConsole(() => withMockFetch(fetch, () => runInit({ cwd: repo, server: SERVER_URL }, deps)));
    assert.ok(logs.some((l) => l.includes("OS-level service install failed (non-fatal)")));
    assert.ok(logs.some((l) => l.includes("twing init: done")), "a failed service install must not abort init");
  });
});

test("runInit: an unsupported platform (e.g. Windows) logs that self-heal is the fallback, not a failure", async () => {
  const { fetch } = captureFetch(jsonResponse({}));
  const { deps } = fakeDeps({ installDaemonService: async () => "unsupported" });
  await withHome(async () => {
    cacheToken(SERVER_URL, "already-cached-pat");
    const repo = tmpRepo();
    const { logs } = await captureConsole(() => withMockFetch(fetch, () => runInit({ cwd: repo, server: SERVER_URL }, deps)));
    assert.ok(logs.some((l) => l.includes("restart-survival relies on the hook's SessionStart self-heal")));
    assert.ok(
      logs.every((l) => !l.includes("failed")),
      "unsupported is not a failure -- must not be logged as one",
    );
  });
});

test("runInit: --invite redeems it (via runKeygen) instead of requiring an already-cached PAT", async () => {
  const { fetch, calls } = captureFetch(jsonResponse({ developerId: "alice@example.com" }));
  const { deps } = fakeDeps();
  await withHome(async () => {
    const repo = tmpRepo();
    const { logs } = await captureConsole(() => withMockFetch(fetch, () => runInit({ cwd: repo, server: SERVER_URL, invite: "invite-code" }, deps)));
    assert.match(calls[0].url, /\/v1\/invites\/invite-code\/redeem$/);
    assert.ok(logs.some((l) => l.includes("twing init: done")));
  });
});

test("runInit: throws without a resolvable server URL, or without an invite/cached PAT", async () => {
  const { deps } = fakeDeps();
  await withHome(async () => {
    const repo = tmpRepo();
    await assert.rejects(() => runInit({ cwd: repo }, deps), /no server URL given/);
    await assert.rejects(() => runInit({ cwd: repo, server: SERVER_URL }, deps), /no personal access token cached/);
  });
});

test("runInit: an explicit --server matching twing.yml's already-committed coordinator doesn't rewrite the file", async () => {
  const { fetch } = captureFetch(jsonResponse({}));
  const { deps } = fakeDeps();
  await withHome(async () => {
    cacheToken(SERVER_URL, "already-cached-pat");
    const repo = tmpRepo(SERVER_URL); // twing.yml already declares this exact coordinator
    const before = fs.readFileSync(path.join(repo, ".twing", "twing.yml"), "utf8");
    const { logs } = await captureConsole(() => withMockFetch(fetch, () => runInit({ cwd: repo, server: SERVER_URL }, deps)));
    assert.equal(fs.readFileSync(path.join(repo, ".twing", "twing.yml"), "utf8"), before);
    assert.equal(
      logs.some((l) => l.includes("wrote coordinator.serverUrl")),
      false,
    );
  });
});

test("runInit: a conflicting already-committed coordinator is left untouched, not silently overwritten", async () => {
  const { fetch } = captureFetch(jsonResponse({}));
  const { deps } = fakeDeps();
  await withHome(async () => {
    cacheToken(SERVER_URL, "already-cached-pat");
    const repo = tmpRepo("http://a-different-server:1111"); // team's real coordinator
    const { logs } = await captureConsole(() => withMockFetch(fetch, () => runInit({ cwd: repo, server: SERVER_URL }, deps)));
    const manifest = fs.readFileSync(path.join(repo, ".twing", "twing.yml"), "utf8");
    assert.match(manifest, /a-different-server:1111/);
    assert.ok(logs.some((l) => l.includes("already declares a different coordinator")));
  });
});

test("runInit: seeds constraints and require_human_review rules when the manifest declares any", async () => {
  const { fetch, calls } = captureFetchSequence([jsonResponse({}), jsonResponse({ seeded: 2 })]);
  const { deps } = fakeDeps();
  await withHome(async () => {
    cacheToken(SERVER_URL, "already-cached-pat");
    const repo = tmpRepo(SERVER_URL);
    fs.writeFileSync(
      path.join(repo, ".twing", "twing.yml"),
      `coordinator:\n  serverUrl: ${SERVER_URL}\n` +
        "constraints:\n  - text: use pkg/retry, don't add another\n    scope: src/**\n" +
        "require_human_review:\n  - path: packages/server/**\n    reason: needs sign-off\n",
    );
    const { logs } = await captureConsole(() => withMockFetch(fetch, () => runInit({ cwd: repo, server: SERVER_URL }, deps)));
    assert.equal(calls.length, 1, "no explicit-server rewrite needed here, so the only call is the constraint seed");
    assert.match(calls[0].url, /\/v1\/constraints\/seed$/);
    const body = calls[0].body as { constraints: { statement: string; type: string }[] };
    assert.equal(body.constraints.length, 2);
    assert.ok(body.constraints.some((c) => c.type === "canonical_abstraction"));
    assert.ok(body.constraints.some((c) => c.type === "review_required"));
    assert.ok(logs.some((l) => l.includes("seeded 2 constraint(s)")));
  });
});

test("runInit: constraint seeding failure is best-effort -- init still reports done", async () => {
  const { fetch } = captureFetch(jsonResponse({ error: "not found" }, 404));
  const { deps } = fakeDeps();
  await withHome(async () => {
    cacheToken(SERVER_URL, "already-cached-pat");
    const repo = tmpRepo(SERVER_URL);
    fs.writeFileSync(
      path.join(repo, ".twing", "twing.yml"),
      `coordinator:\n  serverUrl: ${SERVER_URL}\nconstraints:\n  - text: something\n    scope: src/**\n`,
    );
    const { logs } = await captureConsole(() => withMockFetch(fetch, () => runInit({ cwd: repo, server: SERVER_URL }, deps)));
    assert.ok(logs.some((l) => l.includes("constraint seeding skipped")));
    assert.ok(logs.some((l) => l.includes("twing init: done")), "a failed best-effort seed must not abort init");
  });
});
