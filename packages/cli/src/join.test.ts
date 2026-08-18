/**
 * `postJoinViaGithub` (join.ts) in isolation -- the retry-with-backoff
 * wrapper around the one HTTP call `runJoinGithub` makes to the coordinator
 * after GitHub authorization already succeeded (task #92). Tested directly
 * rather than through `runJoinGithub` end-to-end: the full flow also drives
 * the device-flow poll loop (real `setTimeout`s keyed off GitHub's own
 * `interval`), which is unrelated to what this retry logic needs to prove.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { postJoinViaGithub, JOIN_VIA_GITHUB_MAX_ATTEMPTS } from "./join.js";
import { withMockFetch, captureFetchSequence, jsonResponse, captureConsole } from "./test-support.js";

const SERVER_URL = "http://localhost:9999";

test("postJoinViaGithub: a transient 503 is retried (same call), succeeds on the next attempt", async () => {
  const { fetch, calls } = captureFetchSequence([jsonResponse({ error: "temporarily unavailable" }, 503), jsonResponse({ developerId: "alice@example.com", role: "member" })]);
  const { result } = await captureConsole(() =>
    withMockFetch(fetch, () => postJoinViaGithub(SERVER_URL, "proj-1", { githubToken: "gh-token" }, undefined)),
  );
  assert.equal(calls.length, 2);
  assert.equal(result.result.developerId, "alice@example.com");
});

test("postJoinViaGithub: exhausts all attempts on a persistent 500 and throws, without ever re-running the device flow", async () => {
  const { fetch, calls } = captureFetchSequence([jsonResponse({ error: "internal" }, 500)]);
  await captureConsole(() =>
    assert.rejects(
      () => withMockFetch(fetch, () => postJoinViaGithub(SERVER_URL, "proj-1", { githubToken: "gh-token" }, undefined)),
      /join-via-github failed after 3 attempts/,
    ),
  );
  assert.equal(calls.length, JOIN_VIA_GITHUB_MAX_ATTEMPTS);
  // Every attempt reused the same githubToken already obtained -- nothing
  // about retrying re-requests a device code or re-polls GitHub.
  for (const call of calls) {
    assert.equal((call.body as { githubToken: string }).githubToken, "gh-token");
  }
});

test("postJoinViaGithub: a 4xx (e.g. identity collision) is not retried -- surfaces immediately", async () => {
  const { fetch, calls } = captureFetchSequence([jsonResponse({ error: 'a developer identity for "alice@example.com" already exists' }, 400)]);
  const { result } = await captureConsole(() =>
    withMockFetch(fetch, () => postJoinViaGithub(SERVER_URL, "proj-1", { githubToken: "gh-token" }, undefined)),
  );
  assert.equal(calls.length, 1, "a real rejection shouldn't be retried three times before surfacing");
  assert.equal(result.res.status, 400);
  assert.match(result.result.error ?? "", /already exists/);
});
