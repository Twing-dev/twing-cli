/**
 * Shared fixtures for packages/cli's tests -- extracted from design.test.ts
 * (the first CLI test file written; everything else here follows its
 * conventions). Deliberately not named `*.test.ts` so `node --test
 * dist/*.test.js` doesn't try to run it as its own suite.
 *
 * Two conventions borrowed from elsewhere rather than invented: the
 * `globalThis.fetch`-swap used throughout packages/server's tests
 * (`withMockFetch`), and the throwaway-git-repo-plus-isolated-$HOME fixture
 * `hook/design_gate_test.go` uses for exercising real config resolution
 * instead of mocking `findRepoRoot`/`readConfig` themselves.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** A throwaway repo with `.twing/twing.yml` pointing at `serverUrl` --
 * `findRepoRoot` needs a real `.git` to stop the walk here rather than
 * risking it climbing past the OS tmpdir into whatever's above it. Omit
 * `serverUrl` for the "no coordinator configured" case. */
export function tmpRepo(serverUrl?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twing-cli-test-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  if (serverUrl) {
    fs.mkdirSync(path.join(dir, ".twing"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".twing", "twing.yml"), `coordinator:\n  serverUrl: ${serverUrl}\n`);
  }
  return dir;
}

/** Adds a GitHub `origin` remote to a `tmpRepo()`, so `githubBinding`
 * resolves to `{owner, repo}` -- needed for any test that exercises the
 * GitHub-founding branches (`init.ts`/`join.ts`), which are otherwise
 * skipped entirely for a bare repo with no remote at all. */
export function addGithubRemote(repo: string, owner: string, name: string): void {
  execFileSync("git", ["remote", "add", "origin", `https://github.com/${owner}/${name}.git`], { cwd: repo });
}

/** Sets a `tmpRepo()`'s local `user.email` -- a fresh `git init` has none of
 * its own, so `computeDeveloperId` (git-email-derived) would otherwise fall
 * through to whatever's in the *host machine's* global git config, which is
 * unset/unpredictable in CI. Needed by any test that depends on a specific,
 * deterministic `developerId` (e.g. `--mine` filtering). */
export function setUserEmail(repo: string, email: string): void {
  execFileSync("git", ["config", "user.email", email], { cwd: repo });
}

/** Points `os.homedir()` (via $HOME) at an isolated dir for the duration of
 * `run` -- never touches the real machine's `~/.twing/config.json`, same
 * reasoning as the Go gate tests' `setCachedToken`. */
export async function withHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "twing-cli-home-"));
  const original = process.env.HOME;
  process.env.HOME = home;
  try {
    return await run(home);
  } finally {
    if (original === undefined) delete process.env.HOME;
    else process.env.HOME = original;
  }
}

/** Caches an auth token for `serverUrl` in the current $HOME's config.json
 * -- must be called after `withHome` has already repointed $HOME. */
export function cacheToken(serverUrl: string, token: string): void {
  const configDir = path.join(os.homedir(), ".twing");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ servers: { [serverUrl]: { authToken: token } } }));
}

/** §17 Phase 4 counterpart to `cacheToken`: marks `serverUrl` as a no-auth
 * coordinator in the current $HOME's config.json (no token, `noAuth: true`)
 * -- must be called after `withHome` has repointed $HOME. */
export function cacheNoAuth(serverUrl: string): void {
  const configDir = path.join(os.homedir(), ".twing");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ servers: { [serverUrl]: { noAuth: true } } }));
}

export function withMockFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

export function withEnv<T>(vars: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const originals: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) originals[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return run().finally(() => {
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

export async function captureConsole<T>(run: () => Promise<T>): Promise<{ result: T; logs: string[]; errors: string[]; warnings: string[] }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
  try {
    const result = await run();
    return { result, logs, errors, warnings };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  }
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** For mocking `isReachableCoordinator`'s plain-text root-route check
 * (`init.ts`, §17 Phase 3 GitHub-founding) -- `jsonResponse` bodies don't
 * satisfy it (its exact-text match wants the literal `"twing serve"`, not
 * a JSON blob). */
export function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

/** Captures every fetch call's URL/method and parsed JSON body while
 * returning a fresh `.clone()` of `response` for all of them -- cloning
 * matters now that a single test flow can make more than one call sharing
 * this mock (e.g. `init.ts`'s reachability check ahead of the real
 * request): a `Response` body can only be read once, and multiple calls
 * returning the exact same instance would throw "body already used" the
 * second time anything calls `.text()`/`.json()` on it. For multi-call
 * flows, inspect `calls` directly rather than assuming `calls[0]`. */
export function captureFetch(response: Response): { fetch: typeof fetch; calls: { url: string; method: string; body: unknown }[] } {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined });
    return response.clone();
  }) as typeof fetch;
  return { fetch: impl, calls };
}

/** Same as `captureFetch`, but each call gets the next response in
 * `responses` (repeating the last one if there are more calls than
 * responses) -- for flows that make more than one request. */
export function captureFetchSequence(responses: Response[]): { fetch: typeof fetch; calls: { url: string; method: string; body: unknown }[] } {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined });
    return responses[Math.min(calls.length - 1, responses.length - 1)].clone();
  }) as typeof fetch;
  return { fetch: impl, calls };
}
