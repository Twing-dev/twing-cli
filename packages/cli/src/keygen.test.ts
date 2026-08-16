/**
 * `twing keygen` (keygen.ts) end-to-end at the function boundary. Fixture
 * helpers live in `test-support.ts` -- see that file's header comment.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { runKeygen, generateToken, hashToken } from "./keygen.js";
import { tmpRepo, withHome, cacheToken, withMockFetch, captureConsole, jsonResponse, captureFetch } from "./test-support.js";

const SERVER_URL = "http://localhost:9999";

test("generateToken/hashToken: hashToken is a deterministic sha256 of the plaintext, never the plaintext itself", () => {
  const token = generateToken();
  assert.equal(hashToken(token), hashToken(token));
  assert.notEqual(hashToken(token), token);
  assert.equal(hashToken(token).length, 64); // hex-encoded sha256
});

test("runKeygen: with no cached PAT for this server, mints a fresh one and caches it", async () => {
  const { fetch, calls } = captureFetch(jsonResponse({ developerId: "carol@example.com" }));
  await withHome(async (home) => {
    const repo = tmpRepo();
    const { result: token, logs } = await captureConsole(() =>
      withMockFetch(fetch, () => runKeygen({ cwd: repo, serverUrl: SERVER_URL, invite: "invite-code", label: "carol@example.com" })),
    );
    assert.match(calls[0].url, /\/v1\/invites\/invite-code\/redeem$/);
    const body = calls[0].body as { tokenHash: string; label: string };
    assert.equal(hashToken(token), body.tokenHash, "the server must only ever see the hash, never the plaintext");
    assert.equal(body.label, "carol@example.com");
    assert.ok(logs.some((l) => l.includes("generated a new personal access token")));

    const cachedConfig = JSON.parse(fs.readFileSync(`${home}/.twing/config.json`, "utf8")) as { servers: Record<string, { authToken: string }> };
    assert.equal(cachedConfig.servers[SERVER_URL].authToken, token);
  });
});

test("runKeygen: with an already-cached PAT for this server, reuses it to redeem instead of minting a new one", async () => {
  const { fetch, calls } = captureFetch(jsonResponse({ developerId: "carol@example.com" }));
  await withHome(async () => {
    cacheToken(SERVER_URL, "already-cached-pat");
    const repo = tmpRepo();
    const { result: token, logs } = await captureConsole(() =>
      withMockFetch(fetch, () => runKeygen({ cwd: repo, serverUrl: SERVER_URL, invite: "invite-code" })),
    );
    assert.equal(token, "already-cached-pat");
    assert.equal(calls[0].body, undefined, "reusing an existing PAT redeems with no body, just the bearer token");
    assert.ok(logs.some((l) => l.includes("joined using your existing PAT")));
  });
});

test("runKeygen: throws with the server's error when redemption fails", async () => {
  const { fetch } = captureFetch(jsonResponse({ error: "invite already consumed" }, 400));
  await withHome(async () => {
    const repo = tmpRepo();
    await assert.rejects(
      () => withMockFetch(fetch, () => runKeygen({ cwd: repo, serverUrl: SERVER_URL, invite: "used-code" })),
      /invite already consumed/,
    );
  });
});
