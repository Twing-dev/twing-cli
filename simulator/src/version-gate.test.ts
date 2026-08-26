import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { encodeFrame, FrameDecoder } from "@twing/core";
import { startEphemeralServer } from "./ephemeral-server.js";
import { cliEntryPath } from "./cli-paths.js";

const hookSourceDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "hook");

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A throwaway repo with `.twing/twing.yml` pointing at serverUrl -- same
 * shape packages/cli/src/test-support.ts's tmpRepo() uses. */
function tmpRepo(serverUrl: string): string {
  const dir = tmpDir("twing-sim-repo-");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  fs.mkdirSync(path.join(dir, ".twing"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".twing", "twing.yml"), `coordinator:\n  serverUrl: ${serverUrl}\n`);
  return dir;
}

/** Builds twing-hook fresh from the current source into a scratch path --
 * deterministic (not dependent on whatever happens to already be installed
 * at hookBinaryPath() on this machine), but still a real compiled binary
 * invoked as a real subprocess, same wire contract Claude Code itself uses. */
function buildHookBinary(): string {
  const target = path.join(tmpDir("twing-sim-hook-"), process.platform === "win32" ? "twing-hook.exe" : "twing-hook");
  execFileSync("go", ["build", "-o", target, "."], { cwd: hookSourceDir, stdio: "inherit" });
  return target;
}

test("hook binary: a real twing-hook build denies Edit/Write with a hook-version-mismatch reason against a server declaring a different version", async () => {
  const server = await startEphemeralServer(8791, "9.9.9-simulator-test");
  try {
    const repo = tmpRepo(server.url);
    const hookPath = buildHookBinary();
    const home = tmpDir("twing-sim-home-");
    // Any non-empty token: the version-mismatch middleware runs before auth
    // is ever checked server-side, so this never needs to be a real, valid
    // PAT for this test to exercise the 426 path.
    fs.mkdirSync(path.join(home, ".twing"), { recursive: true });
    fs.writeFileSync(path.join(home, ".twing", "config.json"), JSON.stringify({ servers: { [server.url]: { authToken: "test-token" } } }));

    const payload = {
      session_id: "sim-sess-1",
      cwd: repo,
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: path.join(repo, "foo.ts") },
    };

    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(hookPath, [], { cwd: repo, env: { ...process.env, HOME: home } });
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
      child.once("error", reject);
      child.once("close", () => resolve(out));
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    });

    assert.ok(stdout.length > 0, "hook produced no stdout at all");
    const parsed = JSON.parse(stdout) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
    assert.equal(parsed.hookSpecificOutput?.permissionDecision, "deny");
    const reason = parsed.hookSpecificOutput?.permissionDecisionReason ?? "";
    assert.match(reason, /out of date/);
    assert.match(reason, /9\.9\.9-simulator-test/);
  } finally {
    server.stop();
  }
});

test("daemon: get_notices reports versionMismatch once a claim has been enqueued for a server declaring a different version", async () => {
  const server = await startEphemeralServer(8792, "9.9.9-simulator-test");
  const socketPath = path.join(tmpDir("twing-sim-sock-"), "d.sock");
  const daemonMainPath = path.join(path.dirname(cliEntryPath()), "daemon", "main.js");
  const daemon = spawn(process.execPath, [daemonMainPath], {
    env: { ...process.env, TWING_SOCK: socketPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("daemon did not report ready within 5s")), 5000);
      daemon.stdout.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("listening")) {
          clearTimeout(timer);
          resolve();
        }
      });
      daemon.once("error", reject);
    });

    const repo = tmpRepo(server.url);
    const filePath = path.join(repo, "foo.ts");
    fs.writeFileSync(filePath, "export function foo(): void {}\n");

    // enqueue a real Write claim so the daemon learns repo's projectId -> server.url
    await withSocket(socketPath, async (conn) => {
      conn.write(encodeFrame({ type: "enqueue", sessionId: "sim-sess-2", cwd: repo, toolName: "Write", toolInput: { file_path: filePath } }));
    });

    // Syncer's pollVersions runs on the same 5s poll cadence as notice
    // polling -- poll get_notices until versionMismatch shows up or we give
    // up, rather than guessing a fixed sleep.
    const deadline = Date.now() + 15_000;
    let versionMismatch: { clientVersion: string; serverVersion: string } | undefined;
    while (Date.now() < deadline && !versionMismatch) {
      versionMismatch = await withSocket(socketPath, async (conn) => {
        conn.write(encodeFrame({ type: "get_notices", sessionId: "sim-sess-2" }));
        const msg = await readOneFrame(conn);
        return (msg as { versionMismatch?: { clientVersion: string; serverVersion: string } }).versionMismatch;
      });
      if (!versionMismatch) await new Promise((r) => setTimeout(r, 500));
    }

    assert.ok(versionMismatch, "get_notices never reported a versionMismatch within 15s");
    assert.equal(versionMismatch!.serverVersion, "9.9.9-simulator-test");
  } finally {
    daemon.kill();
    server.stop();
  }
});

function withSocket<T>(socketPath: string, run: (conn: net.Socket) => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socketPath);
    conn.once("connect", () => {
      run(conn)
        .then((result) => {
          conn.end();
          resolve(result);
        })
        .catch((err) => {
          conn.destroy();
          reject(err);
        });
    });
    conn.once("error", reject);
  });
}

function readOneFrame(conn: net.Socket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const decoder = new FrameDecoder();
    const onData = (chunk: Buffer) => {
      try {
        const messages = decoder.push(chunk);
        if (messages.length > 0) {
          conn.off("data", onData);
          resolve(messages[0]);
        }
      } catch (err) {
        conn.off("data", onData);
        reject(err);
      }
    };
    conn.on("data", onData);
  });
}
