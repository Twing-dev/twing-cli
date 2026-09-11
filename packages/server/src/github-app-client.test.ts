import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { mintAppJwt, getInstallationToken, listInstallationRepos, getDefaultBranch, commitFile, readFile, exchangeUserCode } from "./github-app-client.js";

function withMockFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const publicKeyPem = publicKey.export({ type: "pkcs1", format: "pem" }).toString();

test("mintAppJwt: produces a JWT verifiable with the matching public key, iss set to the App ID", () => {
  const jwt = mintAppJwt({ appId: "12345", privateKeyPem });
  const [headerB64, payloadB64, sigB64] = jwt.split(".");
  const signingInput = `${headerB64}.${payloadB64}`;
  const verified = crypto.verify("RSA-SHA256", Buffer.from(signingInput), publicKeyPem, Buffer.from(sigB64, "base64url"));
  assert.equal(verified, true);

  const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  assert.equal(payload.iss, "12345");
  assert.ok(payload.exp > payload.iat);
});

test("getInstallationToken: POSTs to /app/installations/{id}/access_tokens with a bearer JWT, returns the token", async () => {
  let capturedUrl = "";
  let capturedAuth = "";
  let capturedMethod = "";
  const token = await withMockFetch(
    (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedAuth = (init!.headers as Record<string, string>).authorization;
      capturedMethod = init!.method ?? "";
      return new Response(JSON.stringify({ token: "installation-token-abc" }), { status: 201 });
    }) as typeof fetch,
    () => getInstallationToken({ appId: "1", privateKeyPem }, "999"),
  );
  assert.equal(token, "installation-token-abc");
  assert.equal(capturedUrl, "https://api.github.com/app/installations/999/access_tokens");
  assert.equal(capturedMethod, "POST");
  assert.ok(capturedAuth.startsWith("Bearer "));
});

test("getInstallationToken: undefined on a non-200 response", async () => {
  const token = await withMockFetch(
    (async () => new Response("nope", { status: 401 })) as typeof fetch,
    () => getInstallationToken({ appId: "1", privateKeyPem }, "999"),
  );
  assert.equal(token, undefined);
});

test("listInstallationRepos: maps the repositories array to {owner, repo} pairs", async () => {
  const repos = await withMockFetch(
    (async () =>
      new Response(
        JSON.stringify({ repositories: [{ name: "twing-cli", owner: { login: "Twing-dev" } }, { name: "other", owner: { login: "someone" } }] }),
        { status: 200 },
      )) as typeof fetch,
    () => listInstallationRepos("install-token"),
  );
  assert.deepEqual(repos, [
    { owner: "Twing-dev", repo: "twing-cli" },
    { owner: "someone", repo: "other" },
  ]);
});

test("listInstallationRepos: empty array on failure, never throws", async () => {
  const repos = await withMockFetch((async () => new Response("err", { status: 500 })) as typeof fetch, () => listInstallationRepos("bad-token"));
  assert.deepEqual(repos, []);
});

test("listInstallationRepos: never throws on a network-level failure either", async () => {
  const repos = await withMockFetch(
    (async () => {
      throw new Error("ECONNRESET");
    }) as typeof fetch,
    () => listInstallationRepos("bad-token"),
  );
  assert.deepEqual(repos, []);
});

test("listInstallationRepos: paginates past a full first page (per_page=100) instead of silently dropping the rest", async () => {
  const pageOf = (n: number, ownerPrefix: string) => Array.from({ length: n }, (_, i) => ({ name: `repo-${i}`, owner: { login: ownerPrefix } }));
  const calls: string[] = [];
  const repos = await withMockFetch(
    (async (url: string) => {
      calls.push(url);
      const page = new URL(url).searchParams.get("page");
      if (page === "1") return new Response(JSON.stringify({ repositories: pageOf(100, "acme") }), { status: 200 });
      if (page === "2") return new Response(JSON.stringify({ repositories: pageOf(5, "acme") }), { status: 200 });
      throw new Error(`unexpected page ${page}`);
    }) as typeof fetch,
    () => listInstallationRepos("install-token"),
  );
  assert.equal(repos.length, 105);
  assert.equal(calls.length, 2, "must stop after the first short page, not keep paging forever");
});

test("getDefaultBranch: reads default_branch from the repo response", async () => {
  const branch = await withMockFetch(
    (async () => new Response(JSON.stringify({ default_branch: "main" }), { status: 200 })) as typeof fetch,
    () => getDefaultBranch("tok", "owner", "repo"),
  );
  assert.equal(branch, "main");
});

test("commitFile: first-time write (no existing file) omits sha and base64-encodes content", async () => {
  const calls: { url: string; method?: string; body?: unknown }[] = [];
  const result = await withMockFetch(
    (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (!init?.method) return new Response("not found", { status: 404 }); // the pre-read GET
      return new Response(JSON.stringify({ content: {} }), { status: 201 }); // the PUT
    }) as typeof fetch,
    () => commitFile("tok", "owner", "repo", ".twing/twing.yml", "coordinator:\n  serverUrl: https://x\n", "main", "twing setup"),
  );
  assert.equal(result.ok, true);
  const put = calls.find((c) => c.method === "PUT");
  assert.ok(put);
  assert.equal(put!.url, "https://api.github.com/repos/owner/repo/contents/.twing/twing.yml");
  const body = put!.body as { message: string; content: string; branch: string; sha?: string };
  assert.equal(body.branch, "main");
  assert.equal(body.sha, undefined);
  assert.equal(Buffer.from(body.content, "base64").toString("utf8"), "coordinator:\n  serverUrl: https://x\n");
});

test("commitFile: update-in-place includes the existing file's sha", async () => {
  const calls: { method?: string; body?: unknown }[] = [];
  const result = await withMockFetch(
    (async (_url: string, init?: RequestInit) => {
      calls.push({ method: init?.method, body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (!init?.method) return new Response(JSON.stringify({ sha: "abc123" }), { status: 200 }); // pre-read
      return new Response(JSON.stringify({ content: {} }), { status: 200 }); // PUT
    }) as typeof fetch,
    () => commitFile("tok", "owner", "repo", ".claude/settings.json", "{}", "main", "twing setup"),
  );
  assert.equal(result.ok, true);
  const put = calls.find((c) => c.method === "PUT");
  assert.equal((put!.body as { sha?: string }).sha, "abc123");
});

test("commitFile: a non-404 failure on the pre-read is surfaced as an error, no PUT attempted", async () => {
  let putAttempted = false;
  const result = await withMockFetch(
    (async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") putAttempted = true;
      return new Response("rate limited", { status: 429 });
    }) as typeof fetch,
    () => commitFile("tok", "owner", "repo", "x", "y", "main", "msg"),
  );
  assert.equal(result.ok, false);
  assert.equal(putAttempted, false);
});

test("commitFile: a known sha skips the pre-read GET entirely and is used directly in the PUT", async () => {
  const calls: { method?: string }[] = [];
  const result = await withMockFetch(
    (async (_url: string, init?: RequestInit) => {
      calls.push({ method: init?.method });
      return new Response(JSON.stringify({ content: {} }), { status: 200 });
    }) as typeof fetch,
    () => commitFile("tok", "owner", "repo", "x", "content", "main", "msg", "known-sha-abc"),
  );
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1, "no separate pre-read GET when a sha is already known");
  assert.equal(calls[0].method, "PUT");
});

test("commitFile: a known-absent (null) sha also skips the pre-read GET and creates without a sha", async () => {
  const calls: { method?: string; body?: unknown }[] = [];
  const result = await withMockFetch(
    (async (_url: string, init?: RequestInit) => {
      calls.push({ method: init?.method, body: init?.body ? JSON.parse(init.body as string) : undefined });
      return new Response(JSON.stringify({ content: {} }), { status: 201 });
    }) as typeof fetch,
    () => commitFile("tok", "owner", "repo", "x", "content", "main", "msg", null),
  );
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1, "no separate pre-read GET when confirmed absent");
  assert.equal((calls[0].body as { sha?: string }).sha, undefined);
});

test("commitFile: never throws on a network-level failure, surfaces it as an error instead", async () => {
  const result = await withMockFetch(
    (async () => {
      throw new Error("ECONNRESET");
    }) as typeof fetch,
    () => commitFile("tok", "owner", "repo", "x", "y", "main", "msg"),
  );
  assert.equal(result.ok, false);
  assert.ok(result.error?.includes("ECONNRESET"));
});

test("readFile: base64-decodes content and returns the sha on success", async () => {
  const result = await withMockFetch(
    (async () => new Response(JSON.stringify({ content: Buffer.from("hello").toString("base64"), encoding: "base64", sha: "abc123" }), { status: 200 })) as typeof fetch,
    () => readFile("tok", "owner", "repo", ".claude/settings.json", "main"),
  );
  assert.deepEqual(result, { ok: true, content: "hello", sha: "abc123" });
});

test("readFile: notFound:true on a 404 -- distinct from every other failure", async () => {
  const missing = await withMockFetch((async () => new Response("nope", { status: 404 })) as typeof fetch, () => readFile("tok", "o", "r", "x", "main"));
  assert.deepEqual(missing, { ok: false, notFound: true });
});

test("readFile: notFound:false on a transient error, bad encoding, or a missing sha -- never confused with 'doesn't exist'", async () => {
  const serverError = await withMockFetch((async () => new Response("oops", { status: 500 })) as typeof fetch, () => readFile("tok", "o", "r", "x", "main"));
  assert.deepEqual(serverError, { ok: false, notFound: false });

  const badEncoding = await withMockFetch(
    (async () => new Response(JSON.stringify({ content: "hello", encoding: "utf8", sha: "abc" }), { status: 200 })) as typeof fetch,
    () => readFile("tok", "o", "r", "x", "main"),
  );
  assert.deepEqual(badEncoding, { ok: false, notFound: false });

  const noSha = await withMockFetch(
    (async () => new Response(JSON.stringify({ content: Buffer.from("hello").toString("base64"), encoding: "base64" }), { status: 200 })) as typeof fetch,
    () => readFile("tok", "o", "r", "x", "main"),
  );
  assert.deepEqual(noSha, { ok: false, notFound: false });
});

test("exchangeUserCode: posts client credentials + code, returns access_token", async () => {
  let capturedBody: unknown;
  const token = await withMockFetch(
    (async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init!.body as string);
      return new Response(JSON.stringify({ access_token: "user-token-xyz" }), { status: 200 });
    }) as typeof fetch,
    () => exchangeUserCode({ clientId: "cid", clientSecret: "csecret" }, "the-code"),
  );
  assert.equal(token, "user-token-xyz");
  assert.deepEqual(capturedBody, { client_id: "cid", client_secret: "csecret", code: "the-code" });
});

test("exchangeUserCode: undefined on failure, never throws", async () => {
  const token = await withMockFetch((async () => new Response("bad", { status: 400 })) as typeof fetch, () => exchangeUserCode({ clientId: "a", clientSecret: "b" }, "c"));
  assert.equal(token, undefined);
});
