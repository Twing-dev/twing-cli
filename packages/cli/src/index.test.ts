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
