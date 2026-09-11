/**
 * Daemon idle-exit: the daemon must exit on its own once nothing has talked
 * to it for a while, and must not lose the pending claim batch on the way
 * out. Driven as a real detached process against a real socket -- the
 * behavior under test is process lifetime, which an in-process test can't
 * observe (the exit would take the test runner with it).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const DAEMON_MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "main.js");
const IDLE_MS = 700;

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

interface Running {
  child: ChildProcess;
  socketPath: string;
  dir: string;
  exitCode(): number | null;
}

async function startDaemonProcess(): Promise<Running> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twing-idle-exit-"));
  const socketPath = path.join(dir, "daemon.sock");
  const child = spawn(process.execPath, [DAEMON_MAIN], {
    env: { ...process.env, TWING_SOCK: socketPath, TWING_DAEMON_IDLE_MS: String(IDLE_MS) },
    stdio: "ignore",
  });
  let exitCode: number | null = null;
  child.on("exit", (code) => {
    exitCode = code;
  });

  for (let i = 0; i < 60 && !(await socketAlive(socketPath)); i++) await sleep(50);
  return { child, socketPath, dir, exitCode: () => exitCode };
}

test("daemon: exits cleanly once idle, removing its socket and pidfile", async () => {
  const d = await startDaemonProcess();
  try {
    assert.equal(await socketAlive(d.socketPath), true, "daemon should be listening at startup");

    await sleep(IDLE_MS * 3);

    assert.equal(d.exitCode(), 0, "an idle daemon must exit cleanly, not linger or crash");
    assert.equal(fs.existsSync(d.socketPath), false, "socket file must not be left behind for the next daemon to trip over");
    assert.equal(fs.existsSync(path.join(d.dir, "daemon.pid")), false, "pidfile must not outlive the process it names");
  } finally {
    if (d.exitCode() === null) d.child.kill();
  }
});

test("daemon: a client connection re-arms the idle timer", async () => {
  const d = await startDaemonProcess();
  try {
    // Stay under the limit, then connect: if the timer didn't reset, the
    // daemon would be gone by the end of the second wait below.
    await sleep(IDLE_MS * 0.6);
    assert.equal(await socketAlive(d.socketPath), true, "still within the idle window");

    await sleep(IDLE_MS * 0.6);
    assert.equal(d.exitCode(), null, "connecting must push the deadline out, not just read it");
    assert.equal(await socketAlive(d.socketPath), true, "daemon must survive past the original deadline");
  } finally {
    if (d.exitCode() === null) d.child.kill();
  }
});
