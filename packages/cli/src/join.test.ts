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

// --- linkGithubIdentity ------------------------------------------------------
//
// The migration path for people onboarded before verified GitHub identity
// existed. It runs on a machine that already authenticates fine, purely so
// that this person's *other* machines stop being refused with "a developer
// identity for ... already exists". So its whole contract is: attach the
// account when it can, and never disturb a working `init` when it can't.

import { linkGithubIdentity } from "./join.js";
import { tmpRepo, addGithubRemote, withEnv, textResponse } from "./test-support.js";

/** A PATH whose `gh auth token` prints a token, or fails, on demand. */
function ghOnPath(token: string | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twing-gh-"));
  const body = token === null ? "#!/bin/sh\nexit 1\n" : `#!/bin/sh\nprintf '%s' '${token}'\n`;
  fs.writeFileSync(path.join(dir, "gh"), body, { mode: 0o755 });
  return `${dir}:${process.env.PATH ?? ""}`;
}

test("linkGithubIdentity: sends the gh token to the coordinator under the caller's existing PAT", async () => {
  const repo = tmpRepo("http://localhost:9999");
  addGithubRemote(repo, "acme", "widgets");
  const { fetch, calls } = captureFetchSequence([jsonResponse({ developerId: "alice@example.com", role: "member" })]);

  await withEnv({ PATH: ghOnPath("gh-token-abc") }, () =>
    captureConsole(() => withMockFetch(fetch, () => linkGithubIdentity({ cwd: repo, server: SERVER_URL, authToken: "existing-pat" }))),
  );

  assert.equal(calls.length, 1, "one authenticated call is the whole mechanism");
  assert.match(calls[0].url, /\/join-via-github$/);
  const body = calls[0].body as { githubToken?: string; tokenHash?: string };
  assert.equal(body.githubToken, "gh-token-abc");
  assert.equal(body.tokenHash, undefined, "authenticated, so no new identity is being minted here");
});

test("linkGithubIdentity: does nothing at all when gh has no token", async () => {
  // No credential to link. Interrupting a working init to ask for a browser
  // approval would be a worse trade than staying unlinked.
  const repo = tmpRepo("http://localhost:9999");
  addGithubRemote(repo, "acme", "widgets");
  const { fetch, calls } = captureFetchSequence([jsonResponse({})]);

  const { logs } = await withEnv({ PATH: ghOnPath(null) }, () =>
    captureConsole(() => withMockFetch(fetch, () => linkGithubIdentity({ cwd: repo, server: SERVER_URL, authToken: "existing-pat" }))),
  );
  assert.equal(calls.length, 0, "must not call the coordinator with nothing to say");
  assert.deepEqual(logs, [], "and must not narrate a non-event");
});

test("linkGithubIdentity: a non-GitHub repo is skipped silently", async () => {
  const repo = tmpRepo("http://localhost:9999"); // no github remote
  const { fetch, calls } = captureFetchSequence([jsonResponse({})]);
  await withEnv({ PATH: ghOnPath("gh-token-abc") }, () =>
    captureConsole(() => withMockFetch(fetch, () => linkGithubIdentity({ cwd: repo, server: SERVER_URL, authToken: "existing-pat" }))),
  );
  assert.equal(calls.length, 0);
});

test("linkGithubIdentity: a server error never throws -- init keeps working", async () => {
  const repo = tmpRepo("http://localhost:9999");
  addGithubRemote(repo, "acme", "widgets");
  const { fetch } = captureFetchSequence([textResponse("boom", 500)]);
  await withEnv({ PATH: ghOnPath("gh-token-abc") }, () =>
    captureConsole(() => withMockFetch(fetch, () => linkGithubIdentity({ cwd: repo, server: SERVER_URL, authToken: "existing-pat" }))),
  );
  // Reaching here without throwing is the assertion.
});

test("linkGithubIdentity: reports a refusal, because that one needs a human", async () => {
  // The account is already attached to a different twing identity. Everything
  // else about this function is silent; this is the exception, because it is a
  // real situation nobody can resolve without being told about it.
  const repo = tmpRepo("http://localhost:9999");
  addGithubRemote(repo, "acme", "widgets");
  const { fetch } = captureFetchSequence([jsonResponse({ error: 'GitHub account @jc is already linked to the twing identity "someone-else"' }, 400)]);

  const { logs } = await withEnv({ PATH: ghOnPath("gh-token-abc") }, () =>
    captureConsole(() => withMockFetch(fetch, () => linkGithubIdentity({ cwd: repo, server: SERVER_URL, authToken: "existing-pat" }))),
  );
  assert.ok(logs.some((l) => l.includes("already linked to the twing identity")), `expected the refusal to surface, got: ${JSON.stringify(logs)}`);
});
