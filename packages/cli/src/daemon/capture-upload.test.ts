/**
 * `CaptureUploader`. The properties that matter are all about not losing
 * and not duplicating: a rejected upload must be retried with the same
 * bytes, a successful one must never be sent twice, and one unreachable
 * coordinator must not hold back another.
 *
 * Run against a real `node:http` server rather than a stubbed `fetch`, so
 * the request actually has to be well-formed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { CaptureUploader } from "./capture-upload.js";
import type { CaptureTarget } from "./transcript.js";

interface Received {
  sessionId: string;
  records: Record<string, unknown>[];
  projectIds?: string[];
  authorization?: string;
}

/** A coordinator that records what it was sent and can be told to fail. */
async function fakeCoordinator(): Promise<{ url: string; received: Received[]; failWith: (status: number | null) => void; close: () => Promise<void> }> {
  const received: Received[] = [];
  let failStatus: number | null = null;

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (failStatus !== null) {
        res.writeHead(failStatus).end("{}");
        return;
      }
      const parsed = JSON.parse(body) as Omit<Received, "authorization">;
      received.push({ ...parsed, authorization: req.headers.authorization });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ recordCount: parsed.records.length }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    failWith: (status) => {
      failStatus = status;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function scratchSessions(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "twing-upload-test-"));
}

function writeCapture(sessionsDir: string, sessionId: string, records: unknown[]): void {
  fs.appendFileSync(path.join(sessionsDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

function target(serverUrl: string, projectId = "proj-a"): CaptureTarget {
  return { repoRoot: "/repo", projectId, serverUrl };
}

test("CaptureUploader: sends a session's captured records to its coordinator", async () => {
  const coordinator = await fakeCoordinator();
  const sessionsDir = scratchSessions();
  writeCapture(sessionsDir, "s1", [{ type: "session" }, { type: "turn", role: "user", text: "hello" }]);

  const uploader = new CaptureUploader({ sessionsDir });
  uploader.register("s1", [target(coordinator.url)]);
  await uploader.flush();

  assert.equal(coordinator.received.length, 1);
  assert.equal(coordinator.received[0].sessionId, "s1");
  assert.equal(coordinator.received[0].records.length, 2);
  assert.deepEqual(coordinator.received[0].projectIds, ["proj-a"]);
  await coordinator.close();
});

test("CaptureUploader: a second flush sends only what was appended since the first", async () => {
  const coordinator = await fakeCoordinator();
  const sessionsDir = scratchSessions();
  writeCapture(sessionsDir, "s2", [{ n: 1 }]);

  const uploader = new CaptureUploader({ sessionsDir });
  uploader.register("s2", [target(coordinator.url)]);
  await uploader.flush();
  writeCapture(sessionsDir, "s2", [{ n: 2 }]);
  await uploader.flush();

  assert.deepEqual(
    coordinator.received.flatMap((r) => r.records.map((rec) => rec.n)),
    [1, 2],
    "each record sent exactly once",
  );
  await coordinator.close();
});

test("CaptureUploader: nothing new sends no request at all", async () => {
  const coordinator = await fakeCoordinator();
  const sessionsDir = scratchSessions();
  writeCapture(sessionsDir, "s3", [{ n: 1 }]);

  const uploader = new CaptureUploader({ sessionsDir });
  uploader.register("s3", [target(coordinator.url)]);
  await uploader.flush();
  await uploader.flush();

  assert.equal(coordinator.received.length, 1);
  await coordinator.close();
});

// The whole reason the uploader reads the capture file instead of taking the
// records handed to it: a rejected upload must leave the bytes recoverable.
test("CaptureUploader: a rejected upload retries the same records next flush", async () => {
  const coordinator = await fakeCoordinator();
  const sessionsDir = scratchSessions();
  writeCapture(sessionsDir, "s4", [{ n: 1 }, { n: 2 }]);

  const uploader = new CaptureUploader({ sessionsDir });
  uploader.register("s4", [target(coordinator.url)]);

  coordinator.failWith(500);
  await uploader.flush();
  assert.equal(coordinator.received.length, 0, "nothing recorded while failing");

  coordinator.failWith(null);
  await uploader.flush();

  assert.deepEqual(
    coordinator.received.flatMap((r) => r.records.map((rec) => rec.n)),
    [1, 2],
    "the watermark never advanced past the failure",
  );
  await coordinator.close();
});

test("CaptureUploader: an unreachable coordinator does not throw or advance", async () => {
  const sessionsDir = scratchSessions();
  writeCapture(sessionsDir, "s5", [{ n: 1 }]);

  const uploader = new CaptureUploader({ sessionsDir });
  // Port 1 on loopback: nothing is listening, and connecting fails fast.
  uploader.register("s5", [target("http://127.0.0.1:1")]);
  await uploader.flush();

  const coordinator = await fakeCoordinator();
  uploader.register("s5", [target(coordinator.url)]);
  await uploader.flush();

  assert.equal(coordinator.received.length, 1, "the reachable one still gets everything");
  await coordinator.close();
});

// Every opted-in repo consented, so each of their coordinators gets the
// capture -- and each tracks its own watermark, so one being down doesn't
// stall the other.
test("CaptureUploader: a session spanning two coordinators sends to both independently", async () => {
  const a = await fakeCoordinator();
  const b = await fakeCoordinator();
  const sessionsDir = scratchSessions();
  writeCapture(sessionsDir, "s6", [{ n: 1 }]);

  const uploader = new CaptureUploader({ sessionsDir });
  uploader.register("s6", [target(a.url, "proj-a"), target(b.url, "proj-b")]);

  b.failWith(503);
  await uploader.flush();
  assert.equal(a.received.length, 1, "a is not held back by b");

  b.failWith(null);
  writeCapture(sessionsDir, "s6", [{ n: 2 }]);
  await uploader.flush();

  assert.deepEqual(
    a.received.flatMap((r) => r.records.map((x) => x.n)),
    [1, 2],
  );
  assert.deepEqual(
    b.received.flatMap((r) => r.records.map((x) => x.n)),
    [1, 2],
    "b catches up from its own watermark, from the start",
  );
  await a.close();
  await b.close();
});

test("CaptureUploader: a partial trailing line is left for the next flush", async () => {
  const coordinator = await fakeCoordinator();
  const sessionsDir = scratchSessions();
  const capturePath = path.join(sessionsDir, "s7.jsonl");
  fs.writeFileSync(capturePath, JSON.stringify({ n: 1 }) + "\n" + '{"n":2', "utf8");

  const uploader = new CaptureUploader({ sessionsDir });
  uploader.register("s7", [target(coordinator.url)]);
  await uploader.flush();
  assert.deepEqual(
    coordinator.received.flatMap((r) => r.records.map((x) => x.n)),
    [1],
  );

  fs.appendFileSync(capturePath, "}\n", "utf8");
  await uploader.flush();

  assert.deepEqual(
    coordinator.received.flatMap((r) => r.records.map((x) => x.n)),
    [1, 2],
    "the torn record arrives whole, exactly once",
  );
  await coordinator.close();
});

test("CaptureUploader: a session with no capture file yet is a clean no-op", async () => {
  const coordinator = await fakeCoordinator();
  const uploader = new CaptureUploader({ sessionsDir: scratchSessions() });
  uploader.register("never-captured", [target(coordinator.url)]);

  await uploader.flush();

  assert.equal(coordinator.received.length, 0);
  await coordinator.close();
});

test("CaptureUploader: registering no targets means nothing is ever sent", async () => {
  const coordinator = await fakeCoordinator();
  const sessionsDir = scratchSessions();
  writeCapture(sessionsDir, "s8", [{ n: 1 }]);

  const uploader = new CaptureUploader({ sessionsDir });
  uploader.register("s8", []);
  await uploader.flush();

  assert.equal(coordinator.received.length, 0, "a local-only capture stays local");
  await coordinator.close();
});
