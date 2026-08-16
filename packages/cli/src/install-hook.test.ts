/**
 * `releaseAssetName`/`fetchPrebuiltHook` (install-hook.ts) -- the prebuilt-
 * binary fetch tier added alongside `.github/workflows/release-hook.yml`.
 * `ensureHookInstalled` itself isn't covered here (real `go build`
 * subprocess + real filesystem probing of this checkout's own `hook/`
 * source -- same category of real-side-effect problem `init.test.ts`
 * solves via dependency injection; not worth the same treatment for one
 * function with no caller-injectable seam of its own). These two are pure
 * enough (platform mapping, a single `fetch` call) to unit test directly.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { releaseAssetName, fetchPrebuiltHook } from "./install-hook.js";
import { withMockFetch } from "./test-support.js";

function withPlatform<T>(platform: NodeJS.Platform, arch: NodeJS.Architecture, fn: () => T): T {
  const originalPlatform = process.platform;
  const originalArch = process.arch;
  Object.defineProperty(process, "platform", { value: platform });
  Object.defineProperty(process, "arch", { value: arch });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    Object.defineProperty(process, "arch", { value: originalArch });
  }
}

async function withPlatformAsync<T>(platform: NodeJS.Platform, arch: NodeJS.Architecture, fn: () => Promise<T>): Promise<T> {
  const originalPlatform = process.platform;
  const originalArch = process.arch;
  Object.defineProperty(process, "platform", { value: platform });
  Object.defineProperty(process, "arch", { value: arch });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    Object.defineProperty(process, "arch", { value: originalArch });
  }
}

test("releaseAssetName: maps darwin/arm64 to twing-hook-darwin-arm64, no extension", () => {
  withPlatform("darwin", "arm64", () => {
    assert.equal(releaseAssetName(), "twing-hook-darwin-arm64");
  });
});

test("releaseAssetName: maps linux/x64 to twing-hook-linux-amd64 (Go's arch name, not Node's)", () => {
  withPlatform("linux", "x64", () => {
    assert.equal(releaseAssetName(), "twing-hook-linux-amd64");
  });
});

test("releaseAssetName: maps win32/x64 to twing-hook-windows-amd64.exe (Go's OS name, .exe extension)", () => {
  withPlatform("win32", "x64", () => {
    assert.equal(releaseAssetName(), "twing-hook-windows-amd64.exe");
  });
});

test("releaseAssetName: an unsupported platform/arch combo returns null, not a guess", () => {
  withPlatform("freebsd", "x64", () => {
    assert.equal(releaseAssetName(), null);
  });
  withPlatform("linux", "ia32", () => {
    assert.equal(releaseAssetName(), null);
  });
});

test("fetchPrebuiltHook: writes the response body to target and chmods it executable (non-Windows)", async () => {
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "twing-install-hook-test-")), "twing-hook");
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const fakeFetch = (async () => new Response(bytes, { status: 200 })) as typeof fetch;

  const ok = await withMockFetch(fakeFetch, () => withPlatformAsync("darwin", "arm64", () => fetchPrebuiltHook(target)));

  assert.equal(ok, true);
  assert.deepEqual(new Uint8Array(fs.readFileSync(target)), bytes);
  const mode = fs.statSync(target).mode & 0o777;
  assert.equal(mode, 0o755, `mode = ${mode.toString(8)}, want 755`);
});

test("fetchPrebuiltHook: a non-ok response returns false, writes nothing", async () => {
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "twing-install-hook-test-")), "twing-hook");
  const fakeFetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;

  const ok = await withMockFetch(fakeFetch, () => fetchPrebuiltHook(target));

  assert.equal(ok, false);
  assert.equal(fs.existsSync(target), false);
});

test("fetchPrebuiltHook: a network error returns false rather than throwing", async () => {
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "twing-install-hook-test-")), "twing-hook");
  const fakeFetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;

  const ok = await withMockFetch(fakeFetch, () => fetchPrebuiltHook(target));

  assert.equal(ok, false);
  assert.equal(fs.existsSync(target), false);
});

test("fetchPrebuiltHook: an unsupported platform returns false without ever calling fetch", async () => {
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "twing-install-hook-test-")), "twing-hook");
  let fetchCalled = false;
  const fakeFetch = (async () => {
    fetchCalled = true;
    return new Response(new Uint8Array(), { status: 200 });
  }) as typeof fetch;

  const ok = await withMockFetch(fakeFetch, () => withPlatformAsync("freebsd", "x64", () => fetchPrebuiltHook(target)));

  assert.equal(ok, false);
  assert.equal(fetchCalled, false);
});
