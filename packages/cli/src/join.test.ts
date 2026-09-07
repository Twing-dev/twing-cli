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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { postJoinViaGithub, githubTokenFromGhCli, JOIN_VIA_GITHUB_MAX_ATTEMPTS } from "./join.js";
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

// --- githubTokenFromGhCli (non-interactive auth) ------------------------------
//
// The whole of twing's zero-touch auth story: reuse a credential the machine
// already has instead of making a human approve in a browser. Exercised
// against a real `gh` on PATH (a stub), since the point is the subprocess
// call itself.

/** A PATH whose `gh` is a stub behaving as `behavior` describes. */
function pathWithGh(behavior: "token" | "unauthenticated" | "missing"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twing-join-gh-"));
  if (behavior === "token") {
    fs.writeFileSync(path.join(dir, "gh"), "#!/bin/sh\nprintf '%s\\n' 'gho_stubtoken123'\n", { mode: 0o755 });
  } else if (behavior === "unauthenticated") {
    // What a real `gh auth token` does when logged out: fails, message on stderr.
    fs.writeFileSync(path.join(dir, "gh"), "#!/bin/sh\necho 'not logged in' >&2\nexit 1\n", { mode: 0o755 });
  }
  // "missing" -> the directory has no `gh` at all.
  return dir; // deliberately NOT prepended to the real PATH: an isolated PATH
}

function withPath<T>(value: string, run: () => T): T {
  const original = process.env.PATH;
  process.env.PATH = value;
  try {
    return run();
  } finally {
    if (original === undefined) delete process.env.PATH;
    else process.env.PATH = original;
  }
}

test("githubTokenFromGhCli: returns the token when gh is installed and authenticated", () => {
  const token = withPath(pathWithGh("token"), () => githubTokenFromGhCli());
  assert.equal(token, "gho_stubtoken123", "must trim the trailing newline gh prints");
});

test("githubTokenFromGhCli: undefined when gh is present but not authenticated", () => {
  const token = withPath(pathWithGh("unauthenticated"), () => githubTokenFromGhCli());
  assert.equal(token, undefined, "a logged-out gh is the common case, not an error to throw on");
});

test("githubTokenFromGhCli: undefined when gh isn't installed at all", () => {
  const token = withPath(pathWithGh("missing"), () => githubTokenFromGhCli());
  assert.equal(token, undefined, "must never throw -- the device flow is the fallback");
});
