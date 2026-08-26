/**
 * `twing constraints *` (constraints.ts) end-to-end at the function
 * boundary -- same fixtures/conventions as `project.test.ts`. `--project`
 * is always passed explicitly to avoid depending on `computeProjectId`'s
 * real git-remote-based resolution, same deliberate scope as that file.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runConstraintsList, runConstraintsRemove } from "./constraints.js";
import { tmpRepo, withHome, cacheToken, withMockFetch, captureConsole, jsonResponse, captureFetch } from "./test-support.js";

const SERVER_URL = "http://localhost:9999";
const PROJECT_ID = "proj-1";

// --- runConstraintsList -------------------------------------------------------

test("runConstraintsList: appends ?projectId= and prints one line per constraint", async () => {
  const { fetch, calls } = captureFetch(
    jsonResponse({ items: [{ id: "c1", type: "constraint", statement: "use pkg/retry", scope: ["src/**"] }] }),
  );
  await withHome(async () => {
    cacheToken(SERVER_URL, "test-token");
    const repo = tmpRepo();
    const { logs } = await captureConsole(() => withMockFetch(fetch, () => runConstraintsList({ cwd: repo, server: SERVER_URL, project: PROJECT_ID })));
    assert.match(calls[0].url, new RegExp(`/v1/constraints\\?projectId=${PROJECT_ID}$`));
    assert.ok(logs.some((l) => l.includes("c1") && l.includes("use pkg/retry") && l.includes("src/**")));
  });
});

test("runConstraintsList: a 401 response prints the unauthorized hint instead of throwing", async () => {
  const { fetch } = captureFetch(new Response(null, { status: 401 }));
  await withHome(async () => {
    cacheToken(SERVER_URL, "test-token");
    const repo = tmpRepo();
    const { errors } = await captureConsole(() => withMockFetch(fetch, () => runConstraintsList({ cwd: repo, server: SERVER_URL, project: PROJECT_ID })));
    assert.ok(errors.some((e) => e.includes("unauthorized")));
  });
});

test("runConstraintsList: throws without a resolvable server", async () => {
  await withHome(async () => {
    const repo = tmpRepo();
    await assert.rejects(() => runConstraintsList({ cwd: repo, project: PROJECT_ID }), /no server URL given/);
  });
});

// --- runConstraintsRemove -----------------------------------------------------

test("runConstraintsRemove: DELETEs /v1/constraints/:id and reports removed", async () => {
  const { fetch, calls } = captureFetch(jsonResponse({ removed: true }));
  await withHome(async () => {
    cacheToken(SERVER_URL, "test-token");
    const repo = tmpRepo();
    const { logs } = await captureConsole(() => withMockFetch(fetch, () => runConstraintsRemove({ cwd: repo, server: SERVER_URL, id: "c1" })));
    assert.match(calls[0].url, /\/v1\/constraints\/c1$/);
    assert.equal(calls[0].method, "DELETE");
    assert.ok(logs.some((l) => l.includes("c1") && l.includes("removed")));
  });
});

test("runConstraintsRemove: prints the server's error message (e.g. 404 no such constraint) instead of throwing", async () => {
  const { fetch } = captureFetch(jsonResponse({ error: "no such constraint" }));
  await withHome(async () => {
    cacheToken(SERVER_URL, "test-token");
    const repo = tmpRepo();
    const { errors } = await captureConsole(() => withMockFetch(fetch, () => runConstraintsRemove({ cwd: repo, server: SERVER_URL, id: "c1" })));
    assert.ok(errors.some((e) => e.includes("no such constraint")));
  });
});

test("runConstraintsRemove: throws without --id, or without a resolvable server", async () => {
  await withHome(async () => {
    cacheToken(SERVER_URL, "test-token");
    const repo = tmpRepo();
    await assert.rejects(() => runConstraintsRemove({ cwd: repo, server: SERVER_URL }), /--id/);
    await assert.rejects(() => runConstraintsRemove({ cwd: repo, id: "c1" }), /no server URL given/);
  });
});
