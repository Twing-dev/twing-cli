/**
 * `twing project *` (project.ts) end-to-end at the function boundary.
 * Fixture helpers live in `test-support.ts` -- see that file's header
 * comment. `--project` is always passed explicitly to avoid depending on
 * `computeProjectId`'s real git-remote-based resolution (already exercised
 * indirectly by design.test.ts's fixtures, which don't configure a remote
 * either -- consistent, deliberate scope here).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runProjectInvite,
  runProjectListInvites,
  runProjectRevokeInvite,
  runProjectRemoveDeveloper,
  runProjectListDevelopers,
} from "./project.js";
import { tmpRepo, withHome, cacheToken, withMockFetch, captureConsole, jsonResponse, captureFetch } from "./test-support.js";

const SERVER_URL = "http://localhost:9999";
const PROJECT_ID = "proj-1";

// --- runProjectInvite --------------------------------------------------------

test("runProjectInvite: sends label/role scoped to --project and prints the invite code", async () => {
  const { fetch, calls } = captureFetch(jsonResponse({ code: "xyz789", expiresAt: Date.now() + 1000 }));
  await withHome(async () => {
    cacheToken(SERVER_URL, "admin-token");
    const repo = tmpRepo();
    const { logs } = await captureConsole(() =>
      withMockFetch(fetch, () => runProjectInvite({ cwd: repo, server: SERVER_URL, project: PROJECT_ID, label: "dave@example.com", role: "admin" })),
    );
    assert.match(calls[0].url, new RegExp(`/v1/projects/${PROJECT_ID}/invites$`));
    assert.deepEqual(calls[0].body, { label: "dave@example.com", role: "admin" });
    assert.ok(logs.some((l) => l.includes("xyz789")));
    assert.ok(logs.some((l) => l.includes("dave@example.com") && l.includes("twing keygen")));
  });
});

test("runProjectInvite: throws without --label, or without a cached PAT", async () => {
  await withHome(async () => {
    const repo = tmpRepo();
    await assert.rejects(() => runProjectInvite({ cwd: repo, server: SERVER_URL, project: PROJECT_ID }), /--label/);
    await assert.rejects(
      () => runProjectInvite({ cwd: repo, server: SERVER_URL, project: PROJECT_ID, label: "dave@example.com" }),
      /no personal access token cached/,
    );
  });
});

// --- runProjectListInvites ---------------------------------------------------

test("runProjectListInvites: prints pending/consumed/expired status per invite", async () => {
  const now = Date.now();
  const { fetch } = captureFetch(
    jsonResponse({ items: [{ code: "p1", role: "member", label: "a@example.com", expiresAt: now + 100_000 }] }),
  );
  await withHome(async () => {
    cacheToken(SERVER_URL, "admin-token");
    const repo = tmpRepo();
    const { logs } = await captureConsole(() =>
      withMockFetch(fetch, () => runProjectListInvites({ cwd: repo, server: SERVER_URL, project: PROJECT_ID })),
    );
    assert.ok(logs.some((l) => l.includes("p1") && l.includes("[pending]")));
  });
});

// --- runProjectRevokeInvite --------------------------------------------------

test("runProjectRevokeInvite: DELETEs the invite and prints the result status", async () => {
  const { fetch, calls } = captureFetch(jsonResponse({ status: "revoked" }));
  await withHome(async () => {
    cacheToken(SERVER_URL, "admin-token");
    const repo = tmpRepo();
    const { logs } = await captureConsole(() =>
      withMockFetch(fetch, () => runProjectRevokeInvite({ cwd: repo, server: SERVER_URL, code: "xyz789" })),
    );
    assert.equal(calls[0].method, "DELETE");
    assert.match(calls[0].url, /\/v1\/invites\/xyz789$/);
    assert.ok(logs.some((l) => l.includes("revoked")));
  });
});

test("runProjectRevokeInvite: throws without --code", async () => {
  await withHome(async () => {
    cacheToken(SERVER_URL, "admin-token");
    const repo = tmpRepo();
    await assert.rejects(() => runProjectRevokeInvite({ cwd: repo, server: SERVER_URL }), /--code/);
  });
});

// --- runProjectRemoveDeveloper ------------------------------------------------

test("runProjectRemoveDeveloper: DELETEs the membership and prints the result status", async () => {
  const { fetch, calls } = captureFetch(jsonResponse({ status: "removed" }));
  await withHome(async () => {
    cacheToken(SERVER_URL, "admin-token");
    const repo = tmpRepo();
    const { logs } = await captureConsole(() =>
      withMockFetch(fetch, () => runProjectRemoveDeveloper({ cwd: repo, server: SERVER_URL, project: PROJECT_ID, developerId: "dave@example.com" })),
    );
    assert.equal(calls[0].method, "DELETE");
    assert.match(calls[0].url, new RegExp(`/v1/projects/${PROJECT_ID}/developers/dave%40example\\.com$`));
    assert.ok(logs.some((l) => l.includes("removed")));
  });
});

test("runProjectRemoveDeveloper: throws without --developer-id", async () => {
  await withHome(async () => {
    cacheToken(SERVER_URL, "admin-token");
    const repo = tmpRepo();
    await assert.rejects(() => runProjectRemoveDeveloper({ cwd: repo, server: SERVER_URL, project: PROJECT_ID }), /--developer-id/);
  });
});

// --- runProjectListDevelopers --------------------------------------------------

test("runProjectListDevelopers: prints each developer with their role", async () => {
  const { fetch } = captureFetch(jsonResponse({ items: [{ developerId: "dave@example.com", role: "member" }] }));
  await withHome(async () => {
    cacheToken(SERVER_URL, "admin-token");
    const repo = tmpRepo();
    const { logs } = await captureConsole(() =>
      withMockFetch(fetch, () => runProjectListDevelopers({ cwd: repo, server: SERVER_URL, project: PROJECT_ID })),
    );
    assert.ok(logs.some((l) => l.includes("dave@example.com") && l.includes("role=member")));
  });
});
