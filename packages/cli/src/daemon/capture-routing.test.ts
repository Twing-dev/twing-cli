/**
 * The descriptor has to survive the trip from the hook to the capture pass.
 *
 * `transcript-source.ts` resolves a descriptor, `codex-rollout-source.ts` and
 * `opencode-sqlite-source.ts` implement one each, and `transcript.ts` reads
 * whichever it is handed -- all of it covered, all of it passing, and until
 * 2026-09-21 none of it running in production, because the daemon's message
 * handler never passed the descriptor on. OpenCode (a descriptor and no path)
 * was skipped outright; Codex (both) was read as Claude Code JSONL, which
 * parses fine, matches none of the two entry types the filter allows, and
 * moves the watermark past a session nobody captured.
 *
 * So this test is deliberately end-to-end over the socket, with a real daemon
 * process: it is the only shape that would have caught it. It asserts on the
 * capture file, which is the thing a developer would have gone looking for.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFrame } from "@twing/core";

const DAEMON_MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "main.js");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function socketAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createConnection(socketPath);
    probe.once("connect", () => {
      probe.end();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

/** A repo that has opted into capture, which is what makes consent resolve. */
function optedInRepo(dir: string): string {
  const repo = path.join(dir, "repo");
  fs.mkdirSync(path.join(repo, ".twing"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/probe/capture-routing.git"], { cwd: repo });
  fs.writeFileSync(path.join(repo, ".twing", "twing.yml"), "capture:\n  enabled: true\n");
  return repo;
}

/** A Codex rollout carrying one human turn and one assistant turn. */
function codexRollout(dir: string, cwd: string): string {
  const file = path.join(dir, "rollout.jsonl");
  const lines = [
    { type: "session_meta", payload: { session_id: "s", cwd } },
    {
      timestamp: "2026-09-21T03:13:08.000Z",
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "make retries exponential" }] },
    },
    {
      timestamp: "2026-09-21T03:13:09.000Z",
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done -- backoff is exponential now." }] },
    },
  ];
  fs.writeFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
  return file;
}

async function withDaemon(run: (ctx: { socketPath: string; dir: string }) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twing-capture-routing-"));
  const socketPath = path.join(dir, "daemon.sock");
  let child: ChildProcess | undefined;
  try {
    child = spawn(process.execPath, [DAEMON_MAIN], {
      // HOME decides where sessions are written, so the capture of this test
      // lands in the test's own directory and not the developer's.
      env: { ...process.env, HOME: dir, TWING_SOCK: socketPath, TWING_DAEMON_IDLE_MS: "30000" },
      stdio: "ignore",
    });
    for (let i = 0; i < 60 && !(await socketAlive(socketPath)); i++) await sleep(50);
    await run({ socketPath, dir });
  } finally {
    child?.kill();
  }
}

function send(socketPath: string, message: unknown, expectReply: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath, () => client.write(encodeFrame(message)));
    const done = (): void => {
      client.end();
      resolve();
    };
    if (expectReply) client.once("data", done);
    else client.once("connect", () => setTimeout(done, 100));
    client.once("error", reject);
  });
}

/** The capture file for a session, once the daemon has written it. */
async function captureFile(dir: string, sessionId: string): Promise<string | undefined> {
  const file = path.join(dir, ".twing", "sessions", `${sessionId}.jsonl`);
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
    await sleep(100);
  }
  return undefined;
}

test("daemon: a Codex session named by descriptor is captured, not read as Claude Code's format", async () => {
  await withDaemon(async ({ socketPath, dir }) => {
    const repo = optedInRepo(dir);
    const rollout = codexRollout(dir, repo);

    await send(
      socketPath,
      {
        type: "get_notices",
        sessionId: "codex-session",
        cwd: repo,
        // Exactly what `hook/codex.go` sends: both the path (for an older
        // daemon) and the descriptor that says what the path *is*.
        transcriptPath: rollout,
        source: { kind: "codex-rollout", values: { path: rollout } },
      },
      true,
    );

    const captured = await captureFile(dir, "codex-session");
    assert.ok(captured, "the session should have been captured");
    assert.match(captured, /make retries exponential/, "the human turn");
    assert.match(captured, /backoff is exponential now/, "and the assistant's reply");
    assert.match(captured, /"source":"codex-rollout"/, "recorded as what it is");
  });
});

test("daemon: a session_end carrying only a descriptor still drains the transcript", async () => {
  // OpenCode's shape: no per-session file exists, so there is no path to
  // send. A daemon that keys on the path alone captures nothing at all for
  // that harness, for the whole life of every session.
  await withDaemon(async ({ socketPath, dir }) => {
    const repo = optedInRepo(dir);
    const rollout = codexRollout(dir, repo);

    await send(
      socketPath,
      { type: "session_end", sessionId: "descriptor-only", cwd: repo, source: { kind: "codex-rollout", values: { path: rollout } } },
      false,
    );

    const captured = await captureFile(dir, "descriptor-only");
    assert.ok(captured, "a descriptor with no transcriptPath must still capture");
    assert.match(captured, /make retries exponential/);
  });
});

test("daemon: a message naming neither a path nor a descriptor captures nothing", async () => {
  await withDaemon(async ({ socketPath, dir }) => {
    const repo = optedInRepo(dir);

    await send(socketPath, { type: "get_notices", sessionId: "silent", cwd: repo }, true);
    await sleep(300);

    assert.equal(fs.existsSync(path.join(dir, ".twing", "sessions", "silent.jsonl")), false);
  });
});
