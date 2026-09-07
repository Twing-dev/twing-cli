import { test } from "node:test";
import assert from "node:assert/strict";
import { Syncer } from "./sync.js";
import { getCliVersion } from "../version.js";
import { withMockFetch, jsonResponse, withHome, cacheToken } from "../test-support.js";

/** pollVersions is private -- this is whitebox testing of the class's own
 * internals rather than exercising the 5s real timer, same reasoning as
 * calling any other private method directly in a unit test. */
function pollVersions(syncer: Syncer): Promise<void> {
  return (syncer as unknown as { pollVersions(): Promise<void> }).pollVersions();
}

test("Syncer.versionMismatch: null before any version check has run", () => {
  const syncer = new Syncer();
  try {
    assert.equal(syncer.versionMismatch(), null);
  } finally {
    syncer.stop();
  }
});

test("Syncer.versionMismatch: null once the server reports the same version as this client", async () => {
  const syncer = new Syncer();
  try {
    syncer.registerProjectServer("proj-1", "http://coordinator.example");
    await withMockFetch(
      async () => jsonResponse({ version: getCliVersion() }),
      () => pollVersions(syncer),
    );
    assert.equal(syncer.versionMismatch(), null);
  } finally {
    syncer.stop();
  }
});

test("Syncer.versionMismatch: reflects a mocked /v1/version response that differs from this client's own version", async () => {
  const syncer = new Syncer();
  try {
    syncer.registerProjectServer("proj-1", "http://coordinator.example");
    await withMockFetch(
      async () => jsonResponse({ version: "0.0.1-does-not-match" }),
      () => pollVersions(syncer),
    );
    const mismatch = syncer.versionMismatch();
    assert.ok(mismatch);
    assert.equal(mismatch.clientVersion, getCliVersion());
    assert.equal(mismatch.serverVersion, "0.0.1-does-not-match");
  } finally {
    syncer.stop();
  }
});

test("Syncer.versionMismatch: a failed /v1/version check is logged and skipped, not treated as a mismatch", async () => {
  const syncer = new Syncer();
  try {
    syncer.registerProjectServer("proj-1", "http://coordinator.example");
    await withMockFetch(
      async () => {
        throw new Error("network error");
      },
      () => pollVersions(syncer),
    );
    assert.equal(syncer.versionMismatch(), null);
  } finally {
    syncer.stop();
  }
});

// --- stopAndFlush --------------------------------------------------------
//
// Claims sit in a pending batch until the next FLUSH_INTERVAL_MS tick, so
// exiting without a final flush silently drops everything enqueued since
// the previous one. That was survivable while the daemon only exited on an
// explicit shutdown; idle-exit makes it a routine path.

test("Syncer.stopAndFlush: pushes the pending batch instead of dropping it", async () => {
  const serverUrl = "http://localhost:9999";
  await withHome(async () => {
    cacheToken(serverUrl, "pat");
    const syncer = new Syncer();
    syncer.registerProjectServer("proj-1", serverUrl);
    syncer.enqueue(
      { projectId: "proj-1", developerId: "dev@example.com", sessionId: "s1", symbolId: "src/a.ts::f", stage: "firm", ts: Date.now(), ttlMs: 60_000 } as never,
      [],
    );

    const urls: string[] = [];
    const mockFetch = (async (url: string | URL) => {
      urls.push(String(url));
      return jsonResponse({ findings: [] });
    }) as typeof fetch;

    await withMockFetch(mockFetch, () => syncer.stopAndFlush());
    assert.ok(
      urls.some((u) => /\/v1\/claims$/.test(u)),
      "the batch enqueued since the last tick must reach the coordinator before the process exits",
    );
  });
});

test("Syncer.stopAndFlush: a failing coordinator still lets the daemon exit", async () => {
  const serverUrl = "http://localhost:9999";
  await withHome(async () => {
    cacheToken(serverUrl, "pat");
    const syncer = new Syncer();
    syncer.registerProjectServer("proj-1", serverUrl);
    syncer.enqueue(
      { projectId: "proj-1", developerId: "dev@example.com", sessionId: "s1", symbolId: "src/a.ts::f", stage: "firm", ts: Date.now(), ttlMs: 60_000 } as never,
      [],
    );

    const throwingFetch = (async () => {
      throw new Error("coordinator unreachable");
    }) as typeof fetch;

    // Must resolve, not reject: shutdown can't be held hostage by a server
    // that happens to be down.
    await withMockFetch(throwingFetch, () => syncer.stopAndFlush());
  });
});
