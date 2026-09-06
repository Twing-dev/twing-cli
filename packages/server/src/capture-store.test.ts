/**
 * `CaptureStore`. Two properties carry the weight here: appends accumulate
 * across a session's whole life rather than replacing it, and nothing a
 * client sends can steer where a blob lands on disk.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createDb } from "./db/client.js";
import { CaptureStore } from "./capture-store.js";

function freshStore(): { store: CaptureStore; capturesDir: string } {
  const capturesDir = fs.mkdtempSync(path.join(os.tmpdir(), "twing-captures-test-"));
  return { store: new CaptureStore(createDb({ memory: true }), { capturesDir }), capturesDir };
}

function blobs(capturesDir: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(full);
    }
  };
  if (fs.existsSync(capturesDir)) walk(capturesDir);
  return found;
}

test("CaptureStore: a first append creates the blob and the pointer row", () => {
  const { store, capturesDir } = freshStore();

  const summary = store.append({
    sessionId: "s1",
    developerId: "dev-1",
    records: [{ type: "turn", role: "user", text: "why is retry backoff capped?" }],
    projectIds: ["proj-a"],
  });

  assert.equal(summary.sessionId, "s1");
  assert.equal(summary.recordCount, 1);
  assert.deepEqual(summary.projectIds, ["proj-a"]);
  const files = blobs(capturesDir);
  assert.equal(files.length, 1);
  assert.match(fs.readFileSync(files[0], "utf8"), /retry backoff/);
});

// The reason the route appends rather than replaces: a session here runs for
// days and uploads on the daemon's ordinary debounce, so its capture arrives
// in many pieces over its whole life.
test("CaptureStore: later appends accumulate into the same blob and row", () => {
  const { store, capturesDir } = freshStore();

  store.append({ sessionId: "s2", developerId: "dev-1", records: [{ n: 1 }, { n: 2 }] });
  const summary = store.append({ sessionId: "s2", developerId: "dev-1", records: [{ n: 3 }] });

  assert.equal(summary.recordCount, 3);
  const files = blobs(capturesDir);
  assert.equal(files.length, 1, "one blob for the session, not one per upload");
  const lines = fs.readFileSync(files[0], "utf8").trim().split("\n");
  assert.deepEqual(
    lines.map((l) => JSON.parse(l).n),
    [1, 2, 3],
  );
  assert.equal(summary.bytes, fs.statSync(files[0]).size, "byte count is read back from the file, never accumulated");
});

// A session reaches its second opted-in repo hours after its first; the
// earlier one is not retracted by the later one arriving.
test("CaptureStore: projectIds accumulate across appends and never duplicate", () => {
  const { store } = freshStore();

  store.append({ sessionId: "s3", developerId: "dev-1", records: [{ n: 1 }], projectIds: ["proj-a"] });
  const summary = store.append({ sessionId: "s3", developerId: "dev-1", records: [{ n: 2 }], projectIds: ["proj-b", "proj-a"] });

  assert.deepEqual(summary.projectIds, ["proj-a", "proj-b"]);
});

// Session ids come from Claude Code, a process this server has no control
// over, so they are never assumed unique across developers.
test("CaptureStore: the same session id under two developers is two captures", () => {
  const { store, capturesDir } = freshStore();

  const a = store.append({ sessionId: "shared", developerId: "dev-1", records: [{ who: "one" }] });
  const b = store.append({ sessionId: "shared", developerId: "dev-2", records: [{ who: "two" }] });

  assert.notEqual(a.id, b.id);
  assert.equal(blobs(capturesDir).length, 2);
});

// Both inputs to the blob path arrive as strings from elsewhere, so the path
// is hashed rather than interpolated. Nothing a client can send should be
// able to place a file outside the captures directory.
test("CaptureStore: a hostile session id cannot escape the captures directory", () => {
  const { store, capturesDir } = freshStore();
  const hostile = "../../../../../../tmp/twing-escape-" + Date.now();

  store.append({ sessionId: hostile, developerId: "dev-1", records: [{ n: 1 }] });

  const files = blobs(capturesDir);
  assert.equal(files.length, 1);
  for (const file of files) {
    assert.ok(path.resolve(file).startsWith(path.resolve(capturesDir)), `blob escaped: ${file}`);
    assert.match(path.basename(file), /^[0-9a-f]{64}\.jsonl$/, "the name is a digest, never anything the client chose");
  }
});

test("CaptureStore: an empty batch is a no-op that still records the session", () => {
  const { store } = freshStore();

  const summary = store.append({ sessionId: "s4", developerId: "dev-1", records: [] });

  assert.equal(summary.recordCount, 0);
  assert.equal(summary.bytes, 0);
});
