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
import { execFileSync } from "node:child_process";
import { withHome } from "./test-support.js";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { releaseAssetName, fetchPrebuiltHook, ensureCliShim } from "./install-hook.js";
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

// --- ensureCliShim -----------------------------------------------------------
//
// The bootstrap avoids `npm install -g` (sudo), so it leaves no `twing` on
// PATH -- while the design gate's messages all say "run `twing ...`". That
// combination blocked an agent with instructions it could not follow. The
// shim is what makes those instructions runnable.

test("ensureCliShim: writes a runnable twing beside the hook binary", async () => {
  await withHome(async (home) => {
    const shim = ensureCliShim();
    assert.equal(shim, path.join(home, ".twing", "bin", "twing"));
    assert.equal(fs.existsSync(shim!), true);

    // Must actually run. A symlink would inherit dist/index.js's mode, which
    // is only executable when npm installed the package -- not in a checkout.
    const version = execFileSync(shim!, ["--version"], { encoding: "utf8" }).trim();
    assert.match(version, /^\d+\.\d+\.\d+$/, `expected a version, got ${version}`);
  });
});

test("ensureCliShim: is idempotent and repoints at the running build", async () => {
  await withHome(async () => {
    const first = ensureCliShim();
    const second = ensureCliShim();
    assert.equal(first, second);
    // Re-running after an upgrade must not leave the shim aimed at a stale
    // copy, so the body is rewritten rather than skipped.
    assert.match(fs.readFileSync(second!, "utf8"), /dist\/index\.js/);
  });
});

// --- the hook binary must match the CLI package it came with ---------------
//
// The gate compares the *hook binary's* stamped version against the
// coordinator's, so an update that installs `@twing/cli@0.2.21` and then
// fetches the latest hook binary has not updated anything the gate can see.
// It only looked correct because the coordinator happened to sit at the
// newest release; a staged rollout, a rollback, or a pinned deployment made
// automatic recovery unable to converge at all.

test("fetchPrebuiltHook: asks for the release matching the given version first", async () => {
  const requested: string[] = [];
  const fakeFetch = (async (url: string) => {
    requested.push(url);
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  }) as unknown as typeof fetch;

  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "twing-hook-ver-")), "twing-hook");
  const ok = await withMockFetch(fakeFetch, () => withPlatformAsync("linux", "x64", () => fetchPrebuiltHook(target, "0.2.21")));

  assert.equal(ok, true);
  assert.equal(requested.length, 1, "a matching release exists -- latest must not be fetched at all");
  assert.match(requested[0], /\/releases\/download\/v0\.2\.21\/twing-hook-linux-amd64$/);
});

test("fetchPrebuiltHook: falls back to latest when that version has no release asset", async () => {
  // A version published to npm before its hook release finished uploading.
  const requested: string[] = [];
  const fakeFetch = (async (url: string) => {
    requested.push(url);
    if (url.includes("/download/v")) return new Response("not found", { status: 404 });
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  }) as unknown as typeof fetch;

  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "twing-hook-ver-")), "twing-hook");
  const ok = await withMockFetch(fakeFetch, () => withPlatformAsync("linux", "x64", () => fetchPrebuiltHook(target, "9.9.9")));

  assert.equal(ok, true, "a missing per-version asset must not leave the machine with no binary at all");
  assert.equal(requested.length, 2);
  assert.match(requested[1], /\/releases\/latest\/download\//);
});

test("fetchPrebuiltHook: no version given falls straight through to latest", async () => {
  const requested: string[] = [];
  const fakeFetch = (async (url: string) => {
    requested.push(url);
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  }) as unknown as typeof fetch;

  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "twing-hook-ver-")), "twing-hook");
  await withMockFetch(fakeFetch, () => withPlatformAsync("linux", "x64", () => fetchPrebuiltHook(target)));

  assert.deepEqual(requested.length, 1);
  assert.match(requested[0], /\/releases\/latest\/download\//);
});

test("fetchPrebuiltHook: the version sentinel \"unknown\" is not treated as a version", async () => {
  // getCliVersion() returns it when package.json has no version field;
  // there is no `releases/download/vunknown/` to ask for.
  const requested: string[] = [];
  const fakeFetch = (async (url: string) => {
    requested.push(url);
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  }) as unknown as typeof fetch;

  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "twing-hook-ver-")), "twing-hook");
  await withMockFetch(fakeFetch, () => withPlatformAsync("linux", "x64", () => fetchPrebuiltHook(target, "unknown")));

  assert.equal(requested.length, 1);
  assert.match(requested[0], /\/releases\/latest\/download\//);
});
