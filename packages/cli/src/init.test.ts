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
import { computeProjectId } from "@twing/core";
import { runInit, resolveGithubMembership, type InitDeps } from "./init.js";
import {
  tmpRepo,
  withHome,
  cacheToken,
  cacheNoAuth,
  addGithubRemote,
  withMockFetch,
  captureConsole,
  jsonResponse,
  textResponse,
  captureFetch,
  captureFetchSequence,
} from "./test-support.js";

const SERVER_URL = "http://localhost:9999";

/** A URL-substring-routed fetch mock -- needed for tests that exercise more
 * than one distinct endpoint in one `runInit` call (the reachability check,
 * `/v1/auth/whoami`, GitHub's own device-code endpoint, `/v1/constraints/
 * seed`), unlike `captureFetch`/`captureFetchSequence`'s single-response
 * (or fixed-sequence) model. Throws on an unmatched URL rather than
 * returning something arbitrary -- a test that didn't anticipate a call
 * should fail loudly, not silently mask it. */
function routedFetch(routes: { match: RegExp; response: Response }[]): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl = (async (url: string | URL) => {
    const u = String(url);
    calls.push(u);
    const route = routes.find((r) => r.match.test(u));
    if (!route) throw new Error(`routedFetch: no route matched ${u}`);
    return route.response.clone();
  }) as typeof fetch;
  return { fetch: impl, calls };
}

const REACHABILITY_ROUTE = { match: new RegExp(`^${SERVER_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/$`), response: textResponse("twing serve") };

function fakeDeps(overrides: Partial<InitDeps> = {}): {
  deps: InitDeps;
  calls: {
    ensureHookInstalled: true[];
    wireHooks: { hookPath: string }[];
    stripLegacyRepoLocalHooks: { repoRoot: string; hookPath: string }[];
    enableInstallEnforcement: { repoRoot: string }[];
    ensureDaemonRunning: true[];
  };
} {
  const calls = {
    ensureHookInstalled: [] as true[],
    wireHooks: [] as { hookPath: string }[],
    stripLegacyRepoLocalHooks: [] as { repoRoot: string; hookPath: string }[],
    enableInstallEnforcement: [] as { repoRoot: string }[],
    ensureDaemonRunning: [] as true[],
  };
  const deps: InitDeps = {
    ensureHookInstalled: async () => {
      calls.ensureHookInstalled.push(true);
      return "/fake/bin/twing-hook";
    },
    wireHooks: (hookPath) => {
      calls.wireHooks.push({ hookPath });
      return true;
    },
    stripLegacyRepoLocalHooks: (repoRoot, hookPath) => {
      calls.stripLegacyRepoLocalHooks.push({ repoRoot, hookPath });
      return false;
    },
    enableInstallEnforcement: (repoRoot) => {
      calls.enableInstallEnforcement.push({ repoRoot });
      return true;
    },
    ensureDaemonRunning: async () => {
      calls.ensureDaemonRunning.push(true);
      return "started";
    },
    ...overrides,
  };
  return { deps, calls };
}

test("runInit: full flow with an already-cached PAT -- resolves the server, installs/wires/starts, no invite redemption call", async () => {
  const { fetch, calls } = captureFetch(textResponse("twing serve"));
  const { deps, calls: depCalls } = fakeDeps();
  await withHome(async () => {
    cacheToken(SERVER_URL, "already-cached-pat");
    const repo = tmpRepo();
    const { logs } = await captureConsole(() => withMockFetch(fetch, () => runInit({ cwd: repo, server: SERVER_URL }, deps)));

    assert.ok(
      !calls.some((c) => c.url.includes("/constraints/seed")),
      "no constraints/reviews to seed -- must not even attempt the seed call",
    );
    assert.equal(depCalls.wireHooks.length, 1);
    assert.equal(depCalls.wireHooks[0].hookPath, "/fake/bin/twing-hook");
    assert.ok(logs.some((l) => l.includes(`server = ${SERVER_URL}`)));
    assert.ok(logs.some((l) => l.includes("wrote coordinator.serverUrl")));
    assert.ok(logs.some((l) => l.includes("hook installed at /fake/bin/twing-hook")));
    assert.ok(logs.some((l) => l.includes("wired hooks into")));
    assert.ok(logs.some((l) => l.includes("daemon started")));
    assert.ok(logs.some((l) => l.includes("twing init: done")));

    const manifest = fs.readFileSync(path.join(repo, ".twing", "twing.yml"), "utf8");
    assert.match(manifest, new RegExp(SERVER_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    assert.equal(depCalls.stripLegacyRepoLocalHooks.length, 1, "must always check for legacy repo-local entries, even when there's nothing to strip");
    assert.equal(depCalls.stripLegacyRepoLocalHooks[0].repoRoot, repo);
  });
});

test("runInit: reports when legacy repo-local hook entries were found and removed (upgrade migration)", async () => {
  const { fetch } = captureFetch(textResponse("twing serve"));
  const { deps } = fakeDeps({ stripLegacyRepoLocalHooks: () => true });
  await withHome(async () => {
    cacheToken(SERVER_URL, "already-cached-pat");
    const repo = tmpRepo();
    const { logs } = await captureConsole(() => withMockFetch(fetch, () => runInit({ cwd: repo, server: SERVER_URL }, deps)));
    assert.ok(logs.some((l) => l.includes("removed legacy repo-local hook entries")));
  });
});

test("runInit: --invite redeems it (via runKeygen) instead of requiring an already-cached PAT", async () => {
  // Two calls now: the reachability check ahead of committing a fresh
  // coordinator.serverUrl (nothing committed yet in this tmpRepo), then the
  // real invite redemption.
  const { fetch, calls } = captureFetchSequence([textResponse("twing serve"), jsonResponse({ developerId: "alice@example.com" })]);
  const { deps } = fakeDeps();
  await withHome(async () => {
    const repo = tmpRepo();
    const { logs } = await captureConsole(() => withMockFetch(fetch, () => runInit({ cwd: repo, server: SERVER_URL, invite: "invite-code" }, deps)));
    assert.ok(calls.some((c) => /\/v1\/invites\/invite-code\/redeem$/.test(c.url)));
    assert.ok(logs.some((l) => l.includes("twing init: done")));
  });
});

test("runInit: throws without a resolvable server URL, or without an invite/cached PAT", async () => {
  const { deps } = fakeDeps();
  await withHome(async () => {
    const repo = tmpRepo();
    // Non-interactive (no TTY under the test runner) and nothing given at
    // all -- can't even ask, same "how would this ever work" failure mode
    // `promptLine`/`promptPassword` both already use.
    await assert.rejects(() => runInit({ cwd: repo }, deps), /stdin isn't a TTY to prompt on/);

    // A resolvable server, but no invite/cached token and no real GitHub
    // remote in this bare tmp repo (githubBinding is undefined, so the
    // default GitHub attempt is skipped rather than popping a device flow)
    // -- falls through to the "no personal access token cached" error.
    // Reachability of the server itself isn't what's under test here, so
    // it's mocked to succeed.
    const { fetch } = captureFetch(textResponse("twing serve"));
    await withMockFetch(fetch, () => assert.rejects(() => runInit({ cwd: repo, server: SERVER_URL }, deps), /no personal access token cached/));
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
    // 2026-08-26: `type` collapsed to a single value ("constraint") for both
    // the manifest's `constraints:` entries and its `require_human_review:`
    // entries -- see DesignVerdict's doc comment, core/types.ts.
    assert.ok(body.constraints.every((c) => c.type === "constraint"));
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

test("runInit: constraint seeding surfaces the server's real error reason instead of guessing (2026-08-18 fix)", async () => {
  const { fetch } = captureFetch(jsonResponse({ error: "founder has no organization membership" }, 403));
  const { deps } = fakeDeps();
  await withHome(async () => {
    cacheToken(SERVER_URL, "already-cached-pat");
    const repo = tmpRepo(SERVER_URL);
    fs.writeFileSync(
      path.join(repo, ".twing", "twing.yml"),
      `coordinator:\n  serverUrl: ${SERVER_URL}\nconstraints:\n  - text: something\n    scope: src/**\n`,
    );
    const { logs } = await captureConsole(() => withMockFetch(fetch, () => runInit({ cwd: repo, server: SERVER_URL }, deps)));
    assert.ok(
      logs.some((l) => l.includes("founder has no organization membership")),
      "must surface the real server-side reason, not a generic guess",
    );
    assert.ok(
      !logs.some((l) => l.includes("older server, or /v1/designs/* not deployed yet")),
      "must not fall back to the generic guess when the server sent a real reason",
    );
  });
});

// --- per-project membership check (2026-08-18 fix) ---
//
// Found live: a cached token proves this machine is authenticated to a
// *coordinator*, not that this identity is a *member of every project* on
// it. `init` in a second, never-founded repo on an already-onboarded
// coordinator used to reuse the cached token and skip the GitHub-founding
// attempt entirely, silently falling through to the org-based founding
// fallback, which fails for anyone with no org (the default for anyone
// onboarded via GitHub-founding in the first place).

test("resolveGithubMembership: member + role surfaced when the project is in whoami's list", async () => {
  const { fetch } = captureFetch(jsonResponse({ developerId: "me", projects: [{ projectId: "proj-1", orgId: "", role: "admin" }] }));
  const membership = await withMockFetch(fetch, () => resolveGithubMembership(SERVER_URL, "proj-1", "tok"));
  assert.deepEqual(membership, { member: true, role: "admin" });
});

test("resolveGithubMembership: not a member when the project is absent from whoami's list", async () => {
  const { fetch } = captureFetch(jsonResponse({ developerId: "me", projects: [{ projectId: "some-other-proj", orgId: "", role: "admin" }] }));
  const membership = await withMockFetch(fetch, () => resolveGithubMembership(SERVER_URL, "proj-1", "tok"));
  assert.deepEqual(membership, { member: false });
});

test("resolveGithubMembership: fails soft to member=true (role unknown) on a non-ok response", async () => {
  const { fetch } = captureFetch(jsonResponse({ error: "unauthorized" }, 401));
  const membership = await withMockFetch(fetch, () => resolveGithubMembership(SERVER_URL, "proj-1", "tok"));
  assert.deepEqual(membership, { member: true }, "a failed check must not force a surprise join attempt on every retry");
});

test("resolveGithubMembership: fails soft to member=true (role unknown) on a network error", async () => {
  const throwingFetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  const membership = await withMockFetch(throwingFetch, () => resolveGithubMembership(SERVER_URL, "proj-1", "tok"));
  assert.deepEqual(membership, { member: true });
});

test("runInit: a cached token skips the membership check entirely for a non-GitHub-hosted repo (no whoami call)", async () => {
  const { fetch, calls } = captureFetch(textResponse("twing serve"));
  const { deps } = fakeDeps();
  await withHome(async () => {
    cacheToken(SERVER_URL, "already-cached-pat");
    const repo = tmpRepo(); // no github remote at all
    await captureConsole(() => withMockFetch(fetch, () => runInit({ cwd: repo, server: SERVER_URL }, deps)));
    assert.ok(!calls.some((c) => c.url.includes("/v1/auth/whoami")), "no github remote -- membership check must not even run");
  });
});

test("runInit: cached token + already a project member on a GitHub-hosted repo -- no join attempt, seeding still runs", async () => {
  const repo = tmpRepo();
  addGithubRemote(repo, "acme", "widgets");
  const projectId = computeProjectId(repo);
  const { fetch, calls } = routedFetch([
    REACHABILITY_ROUTE,
    { match: /\/v1\/auth\/whoami$/, response: jsonResponse({ developerId: "me", projects: [{ projectId, orgId: "", role: "admin" }] }) },
    { match: /\/v1\/constraints\/seed$/, response: jsonResponse({ seeded: 0 }) },
  ]);
  const { deps, calls: depCalls } = fakeDeps();
  await withHome(async () => {
    cacheToken(SERVER_URL, "already-cached-pat");
    const { logs } = await captureConsole(() => withMockFetch(fetch, () => runInit({ cwd: repo, server: SERVER_URL }, deps)));
    assert.ok(calls.some((c) => /\/v1\/auth\/whoami$/.test(c)), "membership check must run for a github-hosted repo");
    assert.ok(!calls.some((c) => c.includes("github.com/login/device/code")), "already a member -- must not attempt a GitHub join");
    assert.ok(logs.some((l) => l.includes("twing init: done")));
    assert.equal(depCalls.enableInstallEnforcement.length, 1, "an admin re-running init on an already-founded repo must still (re-)write the enforcement hook -- the backfill path");
    assert.equal(depCalls.enableInstallEnforcement[0].repoRoot, repo);
  });
});

test("runInit: cached token + already a project MEMBER (not admin) on a GitHub-hosted repo -- enforcement hook is not written", async () => {
  const repo = tmpRepo();
  addGithubRemote(repo, "acme", "widgets");
  const projectId = computeProjectId(repo);
  const { fetch } = routedFetch([
    REACHABILITY_ROUTE,
    { match: /\/v1\/auth\/whoami$/, response: jsonResponse({ developerId: "me", projects: [{ projectId, orgId: "", role: "member" }] }) },
    { match: /\/v1\/constraints\/seed$/, response: jsonResponse({ seeded: 0 }) },
  ]);
  const { deps, calls: depCalls } = fakeDeps();
  await withHome(async () => {
    cacheToken(SERVER_URL, "already-cached-pat");
    await captureConsole(() => withMockFetch(fetch, () => runInit({ cwd: repo, server: SERVER_URL }, deps)));
    assert.equal(depCalls.enableInstallEnforcement.length, 0, "a plain member must never auto-write the enforcement hook");
  });
});

test("runInit: cached token + NOT yet a project member on a GitHub-hosted repo -- attempts a GitHub join, falls back gracefully if it fails", async () => {
  const repo = tmpRepo();
  addGithubRemote(repo, "acme", "widgets");
  const { fetch, calls } = routedFetch([
    REACHABILITY_ROUTE,
    { match: /\/v1\/auth\/whoami$/, response: jsonResponse({ developerId: "me", projects: [] }) }, // not a member of anything yet
    { match: /github\.com\/login\/device\/code$/, response: jsonResponse({ error: "device flow unavailable in test" }, 500) },
    { match: /\/v1\/constraints\/seed$/, response: jsonResponse({ seeded: 0 }) },
  ]);
  const { deps, calls: depCalls } = fakeDeps();
  await withHome(async () => {
    cacheToken(SERVER_URL, "already-cached-pat");
    const { logs } = await captureConsole(() => withMockFetch(fetch, () => runInit({ cwd: repo, server: SERVER_URL }, deps)));
    assert.ok(calls.some((c) => /\/v1\/auth\/whoami$/.test(c)), "membership check must run");
    assert.ok(calls.some((c) => c.includes("github.com/login/device/code")), "not a member -- must attempt a GitHub join for this project");
    assert.ok(logs.some((l) => l.includes("automatic GitHub-verified join didn't work")));
    assert.ok(logs.some((l) => l.includes("twing init: done")), "a failed join attempt must not abort init -- falls back to the cached token");
    assert.equal(depCalls.enableInstallEnforcement.length, 0, "a failed join attempt must not leave adminRole true");
  });
});

test("runInit: no cached token, GitHub-hosted repo -- a successful founding join (role: admin) writes the enforcement hook", async () => {
  const repo = tmpRepo();
  addGithubRemote(repo, "acme", "widgets");
  const { fetch } = routedFetch([
    REACHABILITY_ROUTE,
    { match: /github\.com\/login\/device\/code$/, response: jsonResponse({ device_code: "d", user_code: "u", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 0 }) },
    { match: /github\.com\/login\/oauth\/access_token$/, response: jsonResponse({ access_token: "gh-token" }) },
    { match: /\/v1\/projects\/.+\/join-via-github$/, response: jsonResponse({ developerId: "me", role: "admin", founded: true }) },
    { match: /\/v1\/constraints\/seed$/, response: jsonResponse({ seeded: 0 }) },
  ]);
  const { deps, calls: depCalls } = fakeDeps();
  await withHome(async () => {
    const { logs } = await captureConsole(() => withMockFetch(fetch, () => runInit({ cwd: repo, server: SERVER_URL }, deps)));
    assert.equal(depCalls.enableInstallEnforcement.length, 1, "founding this project must write the enforcement hook");
    assert.equal(depCalls.enableInstallEnforcement[0].repoRoot, repo);
    assert.ok(
    logs.some((l) => l.includes(".twing/bootstrap-hook.sh") && l.includes(".claude/settings.json")),
    "must name both committed files -- committing only one leaves the repo un-enforced with nothing to say so",
  );
    assert.ok(logs.some((l) => l.includes("There is no bypass flag")));
  });
});

test("runInit: no cached token, GitHub-hosted repo -- joining an already-founded project as a member does not write the enforcement hook", async () => {
  const repo = tmpRepo();
  addGithubRemote(repo, "acme", "widgets");
  const { fetch } = routedFetch([
    REACHABILITY_ROUTE,
    { match: /github\.com\/login\/device\/code$/, response: jsonResponse({ device_code: "d", user_code: "u", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 0 }) },
    { match: /github\.com\/login\/oauth\/access_token$/, response: jsonResponse({ access_token: "gh-token" }) },
    { match: /\/v1\/projects\/.+\/join-via-github$/, response: jsonResponse({ developerId: "me", role: "member", founded: false }) },
    { match: /\/v1\/constraints\/seed$/, response: jsonResponse({ seeded: 0 }) },
  ]);
  const { deps, calls: depCalls } = fakeDeps();
  await withHome(async () => {
    const { logs } = await captureConsole(() => withMockFetch(fetch, () => runInit({ cwd: repo, server: SERVER_URL }, deps)));
    assert.equal(depCalls.enableInstallEnforcement.length, 0, "joining as a plain member must never auto-write the enforcement hook");
    assert.ok(logs.some((l) => l.includes("twing init: done")));
  });
});

test("runInit: --no-github skips the membership check even for a GitHub-hosted repo with a cached token", async () => {
  const repo = tmpRepo();
  addGithubRemote(repo, "acme", "widgets");
  const { fetch, calls } = routedFetch([REACHABILITY_ROUTE, { match: /\/v1\/constraints\/seed$/, response: jsonResponse({ seeded: 0 }) }]);
  const { deps } = fakeDeps();
  await withHome(async () => {
    cacheToken(SERVER_URL, "already-cached-pat");
    await captureConsole(() => withMockFetch(fetch, () => runInit({ cwd: repo, server: SERVER_URL, noGithub: true }, deps)));
    assert.ok(!calls.some((c) => c.includes("/v1/auth/whoami")), "--no-github must skip the membership check entirely");
  });
});

/** A fetch mock that records each request's URL and its `X-Twing-Developer-Id`
 * header -- `routedFetch`/`captureFetch` only expose URLs/bodies, and the
 * no-auth registration path needs the header asserted. Responds "twing
 * serve" to the reachability probe and `{ seeded: 0 }` to `/v1/constraints/
 * seed`; throws on anything else. */
function headerCapturingFetch(): { fetch: typeof fetch; calls: { url: string; developerId: string | null }[] } {
  const calls: { url: string; developerId: string | null }[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, developerId: new Headers(init?.headers).get("x-twing-developer-id") });
    if (/\/$/.test(u)) return textResponse("twing serve");
    if (/\/v1\/constraints\/seed$/.test(u)) return jsonResponse({ seeded: 0 });
    throw new Error(`headerCapturingFetch: no route for ${u}`);
  }) as typeof fetch;
  return { fetch: impl, calls };
}

test("runInit: --no-auth with an empty manifest still calls /v1/constraints/seed to register the project", async () => {
  const { fetch, calls } = headerCapturingFetch();
  const { deps } = fakeDeps();
  await withHome(async () => {
    const repo = tmpRepo(); // no GitHub remote, empty .twing/twing.yml
    const { logs } = await captureConsole(() => withMockFetch(fetch, () => runInit({ cwd: repo, server: SERVER_URL, noAuth: true }, deps)));

    const seed = calls.find((c) => /\/v1\/constraints\/seed$/.test(c.url));
    assert.ok(seed, "no-auth init must register the project even with nothing to seed");
    assert.ok(seed!.developerId && seed!.developerId.length > 0, "the seed call must carry a self-declared X-Twing-Developer-Id header");
    assert.ok(logs.some((l) => l.includes("registered this repo with the coordinator")));
  });
});

test("runInit: a second plain `twing init` against an already-cached no-auth server still fires the registration call", async () => {
  const { fetch, calls } = headerCapturingFetch();
  const { deps } = fakeDeps();
  await withHome(async () => {
    const repo = tmpRepo();
    cacheNoAuth(SERVER_URL); // as if a prior `twing init --no-auth` ran here
    await captureConsole(() => withMockFetch(fetch, () => runInit({ cwd: repo, server: SERVER_URL }, deps)));
    assert.ok(
      calls.some((c) => /\/v1\/constraints\/seed$/.test(c.url)),
      "the sticky no-auth flag must be read back so registration still runs without --no-auth on the re-run",
    );
  });
});

// --- --unattended (zero-touch onboarding) -------------------------------------
//
// Driven by the repo-committed bootstrap hook, so nothing may prompt, wait on
// a browser, or ask for privileges. Each test below pins one of those.

test("runInit --unattended: skips the global hook wiring", async () => {
  const { fetch } = captureFetch(textResponse("twing serve"));
  const { deps, calls } = fakeDeps();
  await withHome(async () => {
    cacheToken(SERVER_URL, "already-cached-pat");
    const repo = tmpRepo(SERVER_URL);
    await captureConsole(() => withMockFetch(fetch, () => runInit({ cwd: repo, unattended: true }, deps)));

    // Global wiring would make BOTH it and the committed hook fire for every
    // tool call: duplicate claims, two gate checks per Edit.
    assert.equal(calls.wireHooks.length, 0, "must not add global wiring alongside the committed hook");
  });
});

test("runInit --unattended: still installs the hook binary and starts the daemon", async () => {
  const { fetch } = captureFetch(textResponse("twing serve"));
  const { deps, calls } = fakeDeps();
  await withHome(async () => {
    cacheToken(SERVER_URL, "already-cached-pat");
    const repo = tmpRepo(SERVER_URL);
    await captureConsole(() => withMockFetch(fetch, () => runInit({ cwd: repo, unattended: true }, deps)));

    // Both are unprivileged, and without the daemon capture/symbol-conflict
    // detection/notice delivery all silently no-op -- a half-working install.
    assert.equal(calls.ensureHookInstalled.length, 1, "the binary is the whole point of the bootstrap");
    assert.equal(calls.ensureDaemonRunning.length, 1, "the daemon is unprivileged and carries half the product");
  });
});

test("runInit --unattended: never writes a git-tracked file, even as an admin", async () => {
  const repo = tmpRepo();
  addGithubRemote(repo, "acme", "widgets");
  const projectId = computeProjectId(repo);
  const { fetch } = routedFetch([
    REACHABILITY_ROUTE,
    { match: /\/v1\/auth\/whoami$/, response: jsonResponse({ developerId: "me", projects: [{ projectId, orgId: "", role: "admin" }] }) },
    { match: /\/v1\/constraints\/seed$/, response: jsonResponse({ seeded: 0 }) },
  ]);
  const { deps, calls } = fakeDeps();
  await withHome(async () => {
    cacheToken(SERVER_URL, "already-cached-pat");
    await captureConsole(() => withMockFetch(fetch, () => runInit({ cwd: repo, server: SERVER_URL, unattended: true }, deps)));
    assert.equal(
      calls.enableInstallEnforcement.length,
      0,
      "committing an enforcement hook is an admin's deliberate act, not something a teammate's first Edit does to their working tree",
    );
  });
});

test("runInit --unattended: throws rather than prompting when no coordinator is configured", async () => {
  const { deps } = fakeDeps();
  await withHome(async () => {
    const repo = tmpRepo(); // no committed .twing/twing.yml, no --server
    await assert.rejects(
      () => runInit({ cwd: repo, unattended: true }, deps),
      /no coordinator configured/,
      "must fail loudly rather than hang on a prompt nobody can answer",
    );
  });
});

// --- pruning the redundant bootstrap copy ------------------------------------
//
// The bootstrap installs a whole @twing/cli into ~/.twing/lib when it can't
// find an existing `twing`. Once a real install is driving `init`, that copy
// is dead weight that only drifts in version -- and a stale second `twing`
// is exactly what caused a version-mismatch deny in testing.

test("runInit: removes the redundant ~/.twing/lib bootstrap copy", async () => {
  const { fetch } = captureFetch(textResponse("twing serve"));
  const { deps } = fakeDeps();
  await withHome(async (home) => {
    cacheToken(SERVER_URL, "already-cached-pat");
    const lib = path.join(home, ".twing", "lib", "node_modules", "@twing", "cli", "dist");
    fs.mkdirSync(lib, { recursive: true });
    fs.writeFileSync(path.join(lib, "index.js"), "// a bootstrap-installed copy\n");

    const repo = tmpRepo(SERVER_URL);
    const { logs } = await captureConsole(() => withMockFetch(fetch, () => runInit({ cwd: repo }, deps)));

    assert.equal(fs.existsSync(path.join(home, ".twing", "lib")), false, "this install supersedes the bootstrap copy");
    assert.ok(logs.some((l) => l.includes("removed the redundant bootstrap copy")));
  });
});

test("runInit: pruning is a no-op when there is no bootstrap copy", async () => {
  const { fetch } = captureFetch(textResponse("twing serve"));
  const { deps } = fakeDeps();
  await withHome(async () => {
    cacheToken(SERVER_URL, "already-cached-pat");
    const repo = tmpRepo(SERVER_URL);
    const { logs } = await captureConsole(() => withMockFetch(fetch, () => runInit({ cwd: repo }, deps)));
    assert.ok(!logs.some((l) => l.includes("removed the redundant bootstrap copy")), "nothing to say when nothing was there");
  });
});
