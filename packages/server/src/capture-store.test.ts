/**
 * `CaptureStore`. Three properties carry the weight here: appends accumulate
 * across a session's whole life rather than replacing it, nothing a client
 * sends can steer where a blob lands on disk, and `read` never depends on a
 * session fitting in memory.
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

// -- read (design review phase 2, 2026-09) ---------------------------------
//
// The first reader of what was a deliberately write-only store. What it has
// to get right is not "return the conversation" -- it is "return a bounded,
// honestly-labelled slice of a conversation that may be enormous".

function turn(n: number, role: "user" | "assistant" = "assistant") {
  return { type: "turn", role, ts: `2026-09-22T00:00:${String(n).padStart(2, "0")}Z`, text: `turn ${n}` };
}

/** Appends `count` turns, optionally interleaving `paths` records. */
function seedSession(store: CaptureStore, count: number, pathsAt: Record<number, string[]> = {}): void {
  const records: Record<string, unknown>[] = [{ type: "session", sessionId: "s1", source: "claude-code-jsonl" }];
  for (let i = 0; i < count; i++) {
    if (pathsAt[i]) records.push({ type: "paths", paths: pathsAt[i] });
    records.push(turn(i));
  }
  store.append({ sessionId: "s1", developerId: "dev@example.com", records });
}

test("CaptureStore.read: a session that was never captured is undefined, not an empty conversation", () => {
  const { store } = freshStore();
  // The difference matters: a repo that never opted in has no conversation,
  // which a caller must say out loud rather than answer from silence.
  assert.equal(store.read("dev@example.com", "never-seen"), undefined);
});

test("CaptureStore.read: keeps both ends of a long session and reports the gap by index", () => {
  const { store } = freshStore();
  seedSession(store, 200);

  const slice = store.read("dev@example.com", "s1", { head: 3, tail: 4 })!;
  assert.equal(slice.totalTurns, 200);
  assert.deepEqual(
    slice.turns.map((t) => t.index),
    [0, 1, 2, 196, 197, 198, 199],
  );
  // The jump from 2 to 196 is how a caller knows to say "193 turns elided"
  // in the right place, rather than implying one break somewhere.
  assert.equal(slice.keptTurns, 7);
});

test("CaptureStore.read: a session shorter than the window comes back whole, with no gap", () => {
  const { store } = freshStore();
  seedSession(store, 5);
  const slice = store.read("dev@example.com", "s1", { head: 3, tail: 4 })!;
  assert.deepEqual(
    slice.turns.map((t) => t.index),
    [0, 1, 2, 3, 4],
  );
  assert.equal(slice.totalTurns, 5);
});

// Removed with the mechanism it covered. `focusPaths` used to select turns
// near where the session named a file; that does not work, because a `paths`
// record is written *after* its batch's turns and paths are deduped
// session-wide (in a real 185-turn session `app.ts` appears in exactly one
// such record despite being edited throughout). Selecting on it returned the
// following, unrelated discussion. See `read`'s doc comment.
test("CaptureStore.read: focusPaths reports what was touched and never steers which turns are kept", () => {
  const { store } = freshStore();
  seedSession(store, 200, { 100: ["/abs/repo/src/retry.ts"] });

  const plain = store.read("dev@example.com", "s1", { head: 2, tail: 2 })!;
  const focused = store.read("dev@example.com", "s1", { head: 2, tail: 2, focusPaths: ["src/retry.ts"] })!;

  assert.deepEqual(
    focused.turns.map((t) => t.index),
    plain.turns.map((t) => t.index),
    "the same turns either way -- relevance is not derivable from this format",
  );
  assert.deepEqual(focused.touchedFocusPaths, ["src/retry.ts"], "but 'was it ever touched' is still sound");
});

test("CaptureStore.read: turns stay in conversation order and are never duplicated across buckets", () => {
  const { store } = freshStore();
  // Head and tail overlap on a session shorter than the two windows.
  seedSession(store, 6, { 3: ["/abs/repo/src/retry.ts"] });
  const slice = store.read("dev@example.com", "s1", { head: 4, tail: 5, focusPaths: ["src/retry.ts"] })!;

  const indices = slice.turns.map((t) => t.index);
  assert.deepEqual(indices, [...indices].sort((a, b) => a - b), "conversation order");
  assert.equal(new Set(indices).size, indices.length, "no turn appears twice");
});

// Found by running this against a real capture: a capture records the
// session's own cwd on nearly every batch, so matching a focus path *inside*
// a recorded path made the repo root light up the entire session -- one
// focus path reported eighteen touched paths.
test("CaptureStore.read: a recorded directory does not count as touching every file beneath it", () => {
  const { store } = freshStore();
  seedSession(store, 10, { 5: ["/abs/repo", "/abs/repo/src/other.ts"] });

  const slice = store.read("dev@example.com", "s1", { head: 1, tail: 1, focusPaths: ["src/retry.ts"] })!;
  assert.deepEqual(slice.touchedFocusPaths, [], "the repo root is not this design's file");
});

test("CaptureStore.read: matches on a segment boundary, not a bare suffix", () => {
  const { store } = freshStore();
  seedSession(store, 10, { 5: ["/abs/repo/src/notretry.ts"] });
  const slice = store.read("dev@example.com", "s1", { head: 1, tail: 1, focusPaths: ["src/retry.ts"] })!;
  assert.deepEqual(slice.touchedFocusPaths, []);
});

test("CaptureStore.read: reports which of the caller's own paths were touched, in the caller's spelling", () => {
  const { store } = freshStore();
  seedSession(store, 10, { 5: ["/home/dev/work/repo/src/retry.ts"] });
  const slice = store.read("dev@example.com", "s1", { focusPaths: ["src/retry.ts", "src/never.ts"] })!;
  // Repo-relative, as a design declares them -- so "1 of 2 declared files"
  // is answerable without the caller re-deriving the absolute mapping.
  assert.deepEqual(slice.touchedFocusPaths, ["src/retry.ts"]);
});

test("CaptureStore.read: keeps session/paths records, which say what the conversation touched", () => {
  const { store } = freshStore();
  seedSession(store, 5, { 2: ["/abs/repo/src/retry.ts"] });
  const slice = store.read("dev@example.com", "s1")!;
  assert.deepEqual(
    slice.other.map((r) => r.type),
    ["session", "paths"],
  );
});

// The blob is append-only and a crash mid-append leaves a partial final
// line. That must cost one record, not the whole read.
test("CaptureStore.read: a torn final line costs that record and nothing else", () => {
  const { store, capturesDir } = freshStore();
  seedSession(store, 5);
  fs.appendFileSync(blobs(capturesDir)[0], '{"type":"turn","role":"user","text":"torn mid-wr');

  const slice = store.read("dev@example.com", "s1")!;
  assert.equal(slice.totalTurns, 5);
});

test("CaptureStore.read: a row whose blob has gone reads as empty, not as never-captured", () => {
  const { store, capturesDir } = freshStore();
  seedSession(store, 5);
  fs.rmSync(blobs(capturesDir)[0]);

  const slice = store.read("dev@example.com", "s1");
  // Distinct facts, and only one of them is a bug.
  assert.notEqual(slice, undefined);
  assert.equal(slice!.totalTurns, 0);
});

test("CaptureStore.read: one developer's capture is not reachable under another's id", () => {
  const { store } = freshStore();
  seedSession(store, 5);
  assert.equal(store.read("someone-else@example.com", "s1"), undefined);
});

// Peak memory has to be the size of the slice, not of the session. A reader
// that assumes the measured 1.6MB median is a bound falls over on the
// session that matters most.
test("CaptureStore.read: a session far larger than the window stays bounded", () => {
  const { store } = freshStore();
  // ~5MB of conversation, well past the chunk size, appended in batches.
  const big = "x".repeat(5_000);
  for (let batch = 0; batch < 10; batch++) {
    store.append({
      sessionId: "s1",
      developerId: "dev@example.com",
      records: Array.from({ length: 100 }, (_, i) => ({ type: "turn", role: "assistant", text: `${batch}-${i} ${big}` })),
    });
  }

  const slice = store.read("dev@example.com", "s1", { head: 5, tail: 5 })!;
  assert.equal(slice.totalTurns, 1000);
  assert.equal(slice.keptTurns, 10);
  assert.match(slice.turns[0].record.text as string, /^0-0 /);
  assert.match(slice.turns[9].record.text as string, /^9-99 /);
});
