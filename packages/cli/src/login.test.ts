/**
 * `twing login` (login.ts) end-to-end at the function boundary. Fixture
 * helpers live in `test-support.ts` -- see that file's header comment.
 * `--token` is always passed explicitly in these tests to avoid needing to
 * drive `promptPassword`'s real stdin prompt.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { runLogin } from "./login.js";
import { tmpRepo, withHome, withMockFetch, captureConsole, jsonResponse, captureFetch } from "./test-support.js";

const SERVER_URL = "http://localhost:9999";

test("runLogin: verifies the token against /v1/auth/whoami and caches it", async () => {
  const { fetch, calls } = captureFetch(jsonResponse({ developerId: "alice@example.com" }));
  await withHome(async (home) => {
    const repo = tmpRepo();
    const { logs } = await captureConsole(() => withMockFetch(fetch, () => runLogin({ cwd: repo, server: SERVER_URL, token: "a-real-pat" })));
    assert.match(calls[0].url, /\/v1\/auth\/whoami$/);
    assert.ok(logs.some((l) => l.includes("authenticated as alice@example.com")));

    const cachedConfig = JSON.parse(fs.readFileSync(`${home}/.twing/config.json`, "utf8")) as { servers: Record<string, { authToken: string }> };
    assert.equal(cachedConfig.servers[SERVER_URL].authToken, "a-real-pat");
  });
});

test("runLogin: throws with the server's rejection reason when the token is invalid, and never caches it", async () => {
  const { fetch } = captureFetch(jsonResponse({ error: "unknown token" }, 401));
  await withHome(async (home) => {
    const repo = tmpRepo();
    await assert.rejects(() => withMockFetch(fetch, () => runLogin({ cwd: repo, server: SERVER_URL, token: "bad-pat" })), /unknown token/);
    assert.equal(fs.existsSync(`${home}/.twing/config.json`), false);
  });
});

test("runLogin: throws without a resolvable server URL", async () => {
  await withHome(async () => {
    const repo = tmpRepo(); // no coordinator, no --server, no TWING_SERVER
    await assert.rejects(() => runLogin({ cwd: repo, token: "t" }), /no server URL given/);
  });
});
