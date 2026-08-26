import { test } from "node:test";
import assert from "node:assert/strict";
import { Syncer } from "./sync.js";
import { getCliVersion } from "../version.js";
import { withMockFetch, jsonResponse } from "../test-support.js";

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
