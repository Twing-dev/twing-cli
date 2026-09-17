/**
 * `twing --version`/`-v` (task #95), exercised as a real subprocess rather
 * than an import -- index.ts calls `main()` unconditionally at module load
 * (it's the CLI entrypoint, not library code), so importing it in-process
 * would run the real dispatcher against this test runner's own argv. Every
 * other subcommand's actual logic lives in its own tested file; this file's
 * only untested-elsewhere behavior is the flag handling that happens before
 * dispatch, which a subprocess is the honest way to check anyway (it's
 * exactly how a user invokes it).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const distDir = path.dirname(fileURLToPath(import.meta.url)); // this test file's own compiled location
const cliEntrypoint = path.join(distDir, "index.js");
const expectedVersion = (JSON.parse(fs.readFileSync(path.join(distDir, "..", "package.json"), "utf8")) as { version: string }).version;

test("twing --version prints this CLI's own package.json version and exits 0", () => {
  const result = spawnSync(process.execPath, [cliEntrypoint, "--version"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), expectedVersion);
});

test("twing -v is the same as --version", () => {
  const result = spawnSync(process.execPath, [cliEntrypoint, "-v"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), expectedVersion);
});

/**
 * The unwired-machine notice.
 *
 * npm >= 12 blocks package install scripts by default, so `npm install -g
 * @twing/cli` writes no hook wiring and says so only in a warning nobody
 * reads. Nothing else can notice: the entire design is that hooks fire
 * without anyone typing a command, so a machine with no wiring is simply
 * silent forever. Confirmed against the real registry, 2026-09-17.
 *
 * The failure mode to guard against is the opposite one -- nagging a
 * perfectly wired machine -- so both directions are pinned here.
 */
function runCliWithHome(home: string, ...args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, [cliEntrypoint, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

test("an unwired machine is told so, and given the command that fixes it", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "twing-unwired-"));
  try {
    const { stderr } = runCliWithHome(home, "--help");
    assert.match(stderr, /not wired into any coding agent/);
    assert.match(stderr, /install\.sh/, "must name the install, not just the problem");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a machine wired the older way is left alone", () => {
  // Binary-path hook entries from a pre-resolver `twing init`, or a repo's
  // committed bootstrap hook: no resolver wiring, but twing is installed and
  // working. Telling this machine it is unwired would be false.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "twing-legacy-wired-"));
  try {
    fs.mkdirSync(path.join(home, ".twing", "bin"), { recursive: true });
    fs.writeFileSync(path.join(home, ".twing", "bin", "twing-hook"), "");
    assert.doesNotMatch(runCliWithHome(home, "--help").stderr, /not wired/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("`twing uninstall` does not nag about wiring it is there to remove", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "twing-uninstall-"));
  try {
    assert.doesNotMatch(runCliWithHome(home, "uninstall", "--dry-run").stderr, /not wired/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
