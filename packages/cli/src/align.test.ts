/**
 * `twing align`'s `respond`/`threads`/`close` subcommands (align.ts) end to
 * end at the function boundary -- each a thin wrapper over one server call.
 * Fixture helpers live in `test-support.ts` -- see that file's header
 * comment.
 *
 * Bare `twing align` (the claim-conflict report and its git-diff fallback)
 * was removed 2026-10-01, and its tests with it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runAlignRespond, runAlignThreads, runAlignClose } from "./align.js";
import { tmpRepo, withHome, cacheToken, withMockFetch, captureConsole, jsonResponse, captureFetch } from "./test-support.js";

const SERVER_URL = "http://localhost:9999";

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

test("runAlignThreads: shows a category tag and every accumulated overlapping file for an amended symbol_claim thread", async () => {
  const { fetch } = captureFetch(
    jsonResponse({
      items: [
        {
          id: "t1",
          status: "open",
          symbolId: "src/x.ts::f",
          symbolIds: ["src/x.ts::f", "src/x.ts::g"],
          developerId: "alice@example.com",
          otherDeveloperId: "bob@example.com",
          systemDescription: "both touched src/x.ts::f",
          category: "symbol_claim",
        },
      ],
    }),
  );
  await withHome(async () => {
    cacheToken(SERVER_URL, "alice-token");
    const repo = tmpRepo(SERVER_URL);
    const { logs } = await captureConsole(() => withMockFetch(fetch, () => runAlignThreads({ cwd: repo })));
    assert.ok(logs.some((l) => l.includes("[symbol_claim]") && l.includes("alice@example.com <-> bob@example.com")));
    assert.ok(logs.some((l) => l.includes("files: src/x.ts::f, src/x.ts::g")), "every accumulated symbol should be listed, not just the first");
  });
});

test("runAlignThreads: a semantic-conflict thread shows its category tag and no files line (nothing to list)", async () => {
  const { fetch } = captureFetch(
    jsonResponse({
      items: [
        {
          id: "t2",
          status: "open",
          symbolId: "",
          symbolIds: [],
          developerId: "alice@example.com",
          otherDeveloperId: "carol@example.com",
          systemDescription: "they fight over the same guarantee",
          category: "tension",
        },
      ],
    }),
  );
  await withHome(async () => {
    cacheToken(SERVER_URL, "alice-token");
    const repo = tmpRepo(SERVER_URL);
    const { logs } = await captureConsole(() => withMockFetch(fetch, () => runAlignThreads({ cwd: repo })));
    assert.ok(logs.some((l) => l.includes("[tension]")));
    assert.ok(!logs.some((l) => l.includes("files:")));
  });
});

test("runAlignThreads: a pre-2026-08-23 thread with no category still lists cleanly, with no category tag and no files line", async () => {
  const { fetch } = captureFetch(
    jsonResponse({
      items: [{ id: "t3", status: "open", symbolId: "src/legacy.ts::Old", developerId: "alice@example.com", otherDeveloperId: "dave@example.com", systemDescription: "a pre-redesign thread" }],
    }),
  );
  await withHome(async () => {
    cacheToken(SERVER_URL, "alice-token");
    const repo = tmpRepo(SERVER_URL);
    const { logs } = await captureConsole(() => withMockFetch(fetch, () => runAlignThreads({ cwd: repo })));
    assert.ok(logs.includes("t3  [open]  alice@example.com <-> dave@example.com"), "no category tag when the thread predates categorization");
    assert.ok(!logs.some((l) => l.includes("files:")));
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
