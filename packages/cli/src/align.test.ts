/**
 * `twing align` and its `respond`/`threads`/`close` subcommands (align.ts)
 * end-to-end at the function boundary. Fixture helpers live in
 * `test-support.ts` -- see that file's header comment.
 *
 * `runAlign` itself is the one command in packages/cli that isn't a thin
 * wrapper over a single server call: it gathers claims first (daemon, then
 * a git-diff fallback -- §6 step 1), then optionally posts them. Both
 * `queryDaemonClaims`/`queryDaemonNotices` (daemon-client.ts) fail soft to
 * `null` when nothing's listening on the socket (a quick real connection
 * attempt against an isolated $HOME's socket path, not mocked -- this is
 * exactly the "works standalone with zero daemon" property under test), so
 * these run against real throwaway git repos rather than mocking the
 * gather step itself.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { runAlign, runAlignRespond, runAlignThreads, runAlignClose } from "./align.js";
import { tmpRepo, withHome, cacheToken, withMockFetch, captureConsole, jsonResponse, captureFetch } from "./test-support.js";

const SERVER_URL = "http://localhost:9999";

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** A repo on `main` with one commit, then a second branch with one more
 * commit adding a genuinely new, real TS source file -- the shape
 * `gatherFromDiff` needs to find a default branch, a merge-base, and at
 * least one changed file to extract real claims from via Tree-sitter. */
function tmpRepoWithDiff(serverUrl?: string): string {
  const dir = tmpRepo(serverUrl);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  git(["checkout", "-q", "-b", "main"], dir);
  fs.writeFileSync(path.join(dir, "README.md"), "placeholder\n");
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "init"], dir);

  git(["checkout", "-q", "-b", "feature"], dir);
  fs.writeFileSync(path.join(dir, "retry.ts"), "export function retry(fn: () => void): void {\n  fn();\n}\n");
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "add retry"], dir);
  return dir;
}

// --- runAlign ----------------------------------------------------------------

test("runAlign: an empty repo with no commits and no daemon reports nothing to compute, without throwing", async () => {
  await withHome(async () => {
    const repo = tmpRepo(); // no coordinator, no commits at all
    const { logs } = await captureConsole(() => runAlign({ cwd: repo }));
    assert.ok(logs.some((l) => l.includes("no daemon running and no default branch found")));
    assert.ok(logs.some((l) => l.includes("skipped -- no server configured")));
  });
});

test("runAlign: with a real diff and a configured coordinator, posts the gathered claims and prints returned findings", async () => {
  const { fetch, calls } = captureFetch(
    jsonResponse({ findings: [{ kind: "textual_overlap", symbolId: "retry.ts::retry", otherDeveloperId: "bob@example.com", reason: "bob is also touching this" }] }),
  );
  await withHome(async () => {
    cacheToken(SERVER_URL, "alice-token");
    const repo = tmpRepoWithDiff(SERVER_URL);
    const { logs } = await captureConsole(() => withMockFetch(fetch, () => runAlign({ cwd: repo })));

    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/v1\/claims$/);
    const body = calls[0].body as { projectId: string; claims: { symbolId: string }[] };
    assert.ok(body.claims.length > 0, "a real new source file on the diff must produce at least one claim");
    assert.ok(logs.some((l) => l.includes("computed from git diff")));
    assert.ok(logs.some((l) => l.includes("textual_overlap") && l.includes("bob@example.com")));
    assert.ok(logs.some((l) => l.includes("bob is also touching this")));
  });
});

test("runAlign: a 401 from the server is reported as unauthorized rather than thrown", async () => {
  const { fetch } = captureFetch(jsonResponse({ error: "unauthorized" }, 401));
  await withHome(async () => {
    cacheToken(SERVER_URL, "stale-token");
    const repo = tmpRepoWithDiff(SERVER_URL);
    const { logs } = await captureConsole(() => withMockFetch(fetch, () => runAlign({ cwd: repo })));
    assert.ok(logs.some((l) => l.includes("unauthorized")));
  });
});

// --- runAlignRespond / runAlignThreads / runAlignClose ------------------------

test("runAlignRespond: posts the message to the thread", async () => {
  const { fetch, calls } = captureFetch(jsonResponse({}));
  await withHome(async () => {
    cacheToken(SERVER_URL, "alice-token");
    const repo = tmpRepo(SERVER_URL);
    const { logs } = await captureConsole(() =>
      withMockFetch(fetch, () => runAlignRespond({ cwd: repo, finding: "thread1", message: "sounds good, I'll adjust" })),
    );
    assert.match(calls[0].url, /\/v1\/alignment-threads\/thread1\/messages$/);
    assert.deepEqual(calls[0].body, { message: "sounds good, I'll adjust" });
    assert.ok(logs.some((l) => l.includes("message posted")));
  });
});

test("runAlignRespond: throws without --finding or --message", async () => {
  await withHome(async () => {
    const repo = tmpRepo(SERVER_URL);
    await assert.rejects(() => runAlignRespond({ cwd: repo, message: "hi" }), /--finding/);
    await assert.rejects(() => runAlignRespond({ cwd: repo, finding: "t1" }), /--message/);
  });
});

test("runAlignThreads: lists open threads with both parties and the system description", async () => {
  const { fetch } = captureFetch(
    jsonResponse({
      items: [{ id: "t1", status: "open", symbolId: "src/x.ts::f", developerId: "alice@example.com", otherDeveloperId: "bob@example.com", systemDescription: "both touched src/x.ts::f" }],
    }),
  );
  await withHome(async () => {
    cacheToken(SERVER_URL, "alice-token");
    const repo = tmpRepo(SERVER_URL);
    const { logs } = await captureConsole(() => withMockFetch(fetch, () => runAlignThreads({ cwd: repo })));
    assert.ok(logs.some((l) => l.includes("alice@example.com <-> bob@example.com")));
    assert.ok(logs.some((l) => l.includes("both touched src/x.ts::f")));
  });
});

test("runAlignThreads: reports plainly when there are none", async () => {
  const { fetch } = captureFetch(jsonResponse({ items: [] }));
  await withHome(async () => {
    cacheToken(SERVER_URL, "alice-token");
    const repo = tmpRepo(SERVER_URL);
    const { logs } = await captureConsole(() => withMockFetch(fetch, () => runAlignThreads({ cwd: repo })));
    assert.ok(logs.some((l) => l.includes("no alignment threads")));
  });
});

test("runAlignClose: PATCHes the thread closed", async () => {
  const { fetch, calls } = captureFetch(jsonResponse({ status: "closed" }));
  await withHome(async () => {
    cacheToken(SERVER_URL, "alice-token");
    const repo = tmpRepo(SERVER_URL);
    await withMockFetch(fetch, () => runAlignClose({ cwd: repo, finding: "thread1" }));
    assert.equal(calls[0].method, "PATCH");
    assert.match(calls[0].url, /\/v1\/alignment-threads\/thread1\/close$/);
  });
});

test("runAlignClose: throws without --finding", async () => {
  await withHome(async () => {
    const repo = tmpRepo(SERVER_URL);
    await assert.rejects(() => runAlignClose({ cwd: repo }), /--finding/);
  });
});
