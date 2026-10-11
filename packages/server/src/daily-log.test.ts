import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DailyLog, sweepOldLogs, redact, capBody, describeBody } from "./daily-log.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "twing-daily-log-"));
}

test("DailyLog writes one JSON line per entry into today's file", async () => {
  const dir = tempDir();
  const log = new DailyLog(dir, "http", () => new Date("2026-10-11T09:00:00Z"));
  log.write({ path: "/v1/version", status: 200 });
  log.write({ path: "/v1/designs", status: 201 });
  await log.close();
  const lines = fs.readFileSync(path.join(dir, "http-2026-10-11.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].ts, "2026-10-11T09:00:00.000Z");
  assert.equal(lines[1].status, 201);
});

test("DailyLog rolls over to a new file when the UTC date changes", async () => {
  const dir = tempDir();
  let now = new Date("2026-10-11T23:59:59Z");
  const log = new DailyLog(dir, "llm", () => now);
  log.write({ n: 1 });
  now = new Date("2026-10-12T00:00:01Z");
  log.write({ n: 2 });
  await log.close();
  assert.deepEqual(fs.readdirSync(dir).sort(), ["llm-2026-10-11.jsonl", "llm-2026-10-12.jsonl"]);
});

test("sweepOldLogs deletes files past retention and leaves everything else", () => {
  const dir = tempDir();
  for (const name of ["http-2026-10-03.jsonl", "llm-2026-10-04.jsonl", "http-2026-10-05.jsonl", "http-2026-10-11.jsonl", "notes.txt"]) {
    fs.writeFileSync(path.join(dir, name), "");
  }
  const removed = sweepOldLogs(dir, 7, new Date("2026-10-11T12:00:00Z"));
  assert.deepEqual(removed.sort(), ["http-2026-10-03.jsonl", "llm-2026-10-04.jsonl"]);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["http-2026-10-05.jsonl", "http-2026-10-11.jsonl", "notes.txt"]);
});

test("sweepOldLogs tolerates a missing directory", () => {
  assert.deepEqual(sweepOldLogs(path.join(tempDir(), "absent"), 7), []);
});

test("redact strips secret-looking keys at any depth", () => {
  assert.deepEqual(
    redact({ bootstrapToken: "abc", label: "me", nested: [{ githubToken: "x", authorization: "Bearer y", ok: 1 }] }),
    { bootstrapToken: "[redacted]", label: "me", nested: [{ githubToken: "[redacted]", authorization: "[redacted]", ok: 1 }] },
  );
});

test("capBody truncates oversized text with a marker", () => {
  assert.equal(capBody("short", 10), "short");
  assert.equal(capBody("0123456789abc", 10), "0123456789…[truncated 3 bytes]");
});

test("describeBody parses+redacts JSON, keeps text, sizes binary", () => {
  assert.deepEqual(describeBody("application/json", '{"token":"t","a":1}'), { token: "[redacted]", a: 1 });
  assert.equal(describeBody("text/plain", "hello"), "hello");
  assert.deepEqual(describeBody("application/octet-stream", "abcd"), { contentType: "application/octet-stream", bytes: 4 });
  assert.equal(describeBody("application/json", ""), undefined);
});
