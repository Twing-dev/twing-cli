/**
 * `twing admin *` (admin.ts) end-to-end at the function boundary. Fixture
 * helpers live in `test-support.ts` -- see that file's header comment.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import {
  runAdminBootstrap,
  runAdminInvite,
  runAdminListInvites,
  runAdminRevokeInvite,
  runAdminRevokeDeveloper,
  runAdminListDevelopers,
} from "./admin.js";
import { tmpRepo, withHome, cacheToken, withMockFetch, captureConsole, jsonResponse, captureFetch } from "./test-support.js";

const SERVER_URL = "http://localhost:9999";

// --- runAdminBootstrap -----------------------------------------------------

test("runAdminBootstrap: claims the bootstrap token, generates a PAT, and caches it", async () => {
  const { fetch, calls } = captureFetch(jsonResponse({ developerId: "alice@example.com", orgId: "org1" }));
  await withHome(async (home) => {
    const repo = tmpRepo();
    const { logs } = await captureConsole(() =>
      withMockFetch(fetch, () => runAdminBootstrap({ cwd: repo, server: SERVER_URL, token: "the-bootstrap-token", label: "alice@example.com" })),
    );
    assert.match(calls[0].url, /\/v1\/admin\/bootstrap$/);
    const body = calls[0].body as { bootstrapToken: string; tokenHash: string; label: string };
    assert.equal(body.bootstrapToken, "the-bootstrap-token");
    assert.equal(body.label, "alice@example.com");
    assert.equal(typeof body.tokenHash, "string");
    assert.ok(logs.some((l) => l.includes("org1") && l.includes("alice@example.com")));

    // The generated PAT must actually be cached, not just printed.
    const cachedConfig = JSON.parse(fs.readFileSync(`${home}/.twing/config.json`, "utf8")) as { servers: Record<string, { authToken: string }> };
    assert.equal(typeof cachedConfig.servers[SERVER_URL].authToken, "string");
  });
});

test("runAdminBootstrap: throws with the server's error message when the bootstrap token is rejected", async () => {
  const { fetch } = captureFetch(jsonResponse({ error: "invalid bootstrap token" }, 403));
  await withHome(async () => {
    const repo = tmpRepo();
    await assert.rejects(
      () => withMockFetch(fetch, () => runAdminBootstrap({ cwd: repo, server: SERVER_URL, token: "wrong" })),
      /invalid bootstrap token/,
    );
  });
});

test("runAdminBootstrap: throws without a resolvable server URL or bootstrap token", async () => {
  await withHome(async () => {
    const repo = tmpRepo();
    await assert.rejects(() => runAdminBootstrap({ cwd: repo, token: "t" }), /no server URL given/);
    await assert.rejects(() => runAdminBootstrap({ cwd: repo, server: SERVER_URL }), /no bootstrap token given/);
  });
});

// --- runAdminInvite ---------------------------------------------------------

test("runAdminInvite: sends label/role/orgId and prints the invite code", async () => {
  const { fetch, calls } = captureFetch(jsonResponse({ code: "abc123", expiresAt: Date.now() + 1000 }));
  await withHome(async () => {
    cacheToken(SERVER_URL, "admin-token");
    const repo = tmpRepo();
    const { logs } = await captureConsole(() =>
      withMockFetch(fetch, () => runAdminInvite({ cwd: repo, server: SERVER_URL, label: "bob@example.com", role: "member", orgId: "org1" })),
    );
    assert.match(calls[0].url, /\/v1\/admin\/invites$/);
    assert.deepEqual(calls[0].body, { label: "bob@example.com", role: "member", orgId: "org1" });
    assert.ok(logs.some((l) => l.includes("abc123")));
    assert.ok(logs.some((l) => l.includes("bob@example.com") && l.includes("twing keygen")));
  });
});

test("runAdminInvite: throws without --label, or without a cached PAT", async () => {
  await withHome(async () => {
    const repo = tmpRepo();
    await assert.rejects(() => runAdminInvite({ cwd: repo, server: SERVER_URL }), /--label/);
    cacheToken("http://a-different-server", "irrelevant");
    await assert.rejects(() => runAdminInvite({ cwd: repo, server: SERVER_URL, label: "bob@example.com" }), /no personal access token cached/);
  });
});

// --- runAdminListInvites ----------------------------------------------------

test("runAdminListInvites: prints pending/consumed/expired status per invite", async () => {
  const now = Date.now();
  const { fetch } = captureFetch(
    jsonResponse({
      items: [
        { code: "pending1", role: "member", label: "a@example.com", expiresAt: now + 100_000 },
        { code: "consumed1", role: "member", label: "b@example.com", expiresAt: now + 100_000, consumedAt: now },
        { code: "expired1", role: "admin", label: "c@example.com", expiresAt: now - 1 },
      ],
    }),
  );
  await withHome(async () => {
    cacheToken(SERVER_URL, "admin-token");
    const repo = tmpRepo();
    const { logs } = await captureConsole(() => withMockFetch(fetch, () => runAdminListInvites({ cwd: repo, server: SERVER_URL })));
    assert.ok(logs.some((l) => l.includes("pending1") && l.includes("[pending]")));
    assert.ok(logs.some((l) => l.includes("consumed1") && l.includes("[consumed]")));
    assert.ok(logs.some((l) => l.includes("expired1") && l.includes("[expired]")));
  });
});

// --- runAdminRevokeInvite ---------------------------------------------------

test("runAdminRevokeInvite: DELETEs the invite and prints the result status", async () => {
  const { fetch, calls } = captureFetch(jsonResponse({ status: "revoked" }));
  await withHome(async () => {
    cacheToken(SERVER_URL, "admin-token");
    const repo = tmpRepo();
    const { logs } = await captureConsole(() => withMockFetch(fetch, () => runAdminRevokeInvite({ cwd: repo, server: SERVER_URL, code: "abc123" })));
    assert.equal(calls[0].method, "DELETE");
    assert.match(calls[0].url, /\/v1\/invites\/abc123$/);
    assert.ok(logs.some((l) => l.includes("revoked")));
  });
});

test("runAdminRevokeInvite: throws without --code", async () => {
  await withHome(async () => {
    cacheToken(SERVER_URL, "admin-token");
    const repo = tmpRepo();
    await assert.rejects(() => runAdminRevokeInvite({ cwd: repo, server: SERVER_URL }), /--code/);
  });
});

// --- runAdminRevokeDeveloper ------------------------------------------------

test("runAdminRevokeDeveloper: POSTs the revoke and prints the result status", async () => {
  const { fetch, calls } = captureFetch(jsonResponse({ status: "revoked" }));
  await withHome(async () => {
    cacheToken(SERVER_URL, "admin-token");
    const repo = tmpRepo();
    const { logs } = await captureConsole(() =>
      withMockFetch(fetch, () => runAdminRevokeDeveloper({ cwd: repo, server: SERVER_URL, developerId: "bob@example.com" })),
    );
    assert.match(calls[0].url, /\/v1\/admin\/developers\/bob%40example\.com\/revoke$/);
    assert.ok(logs.some((l) => l.includes("revoked")));
  });
});

test("runAdminRevokeDeveloper: throws without --developer-id", async () => {
  await withHome(async () => {
    cacheToken(SERVER_URL, "admin-token");
    const repo = tmpRepo();
    await assert.rejects(() => runAdminRevokeDeveloper({ cwd: repo, server: SERVER_URL }), /--developer-id/);
  });
});

// --- runAdminListDevelopers -------------------------------------------------

test("runAdminListDevelopers: prints each developer with their role", async () => {
  const { fetch } = captureFetch(jsonResponse({ items: [{ developerId: "alice@example.com", role: "admin" }] }));
  await withHome(async () => {
    cacheToken(SERVER_URL, "admin-token");
    const repo = tmpRepo();
    const { logs } = await captureConsole(() => withMockFetch(fetch, () => runAdminListDevelopers({ cwd: repo, server: SERVER_URL })));
    assert.ok(logs.some((l) => l.includes("alice@example.com") && l.includes("role=admin")));
  });
});
