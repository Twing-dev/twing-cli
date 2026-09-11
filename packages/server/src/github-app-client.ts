/**
 * GitHub App API client for the Setup URL route (`app.ts`'s
 * `/v1/github-app/setup`) -- everything `github-client.ts` doesn't need
 * because it only ever reads on the caller's own behalf. This file signs as
 * the App itself (JWT -> installation access token) and writes: it's what
 * lets an admin go from "install the App" to "repo fully onboarded" without
 * ever running the CLI.
 *
 * Hand-rolled JWT minting rather than a `jsonwebtoken` dependency, matching
 * this codebase's plain-`fetch`-no-SDK convention for every other external
 * API (`llm-client.ts`, `github-client.ts`) -- GitHub App auth needs exactly
 * one JWT shape (RS256, `iss` = App ID, short-lived), not a general-purpose
 * JWT library.
 */

import * as crypto from "node:crypto";

export interface GithubAppCredentials {
  appId: string;
  privateKeyPem: string;
  clientId: string;
  clientSecret: string;
}

function base64url(input: Buffer | string): string {
  return (Buffer.isBuffer(input) ? input : Buffer.from(input)).toString("base64url");
}

/**
 * Mints a short-lived App JWT per GitHub's App-authentication spec: RS256,
 * `iss` = App ID, a small backdated `iat` for clock drift, `exp` capped at
 * GitHub's 10-minute maximum (9 minutes used, leaving margin).
 */
export function mintAppJwt(creds: Pick<GithubAppCredentials, "appId" | "privateKeyPem">): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp: now + 9 * 60, iss: creds.appId };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), creds.privateKeyPem);
  return `${signingInput}.${base64url(signature)}`;
}

async function githubRequest(path: string, token: string, init?: RequestInit): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "twing-cli",
      ...(init?.headers ?? {}),
    },
  });
}

/** Exchanges the App's JWT for an installation access token -- the
 * credential every write call below actually uses; the JWT itself can only
 * mint tokens, not call the rest of the API. `undefined` on any non-200
 * (installation revoked mid-flow, bad credentials, etc.), same "caller
 * treats every failure identically" convention `github-client.ts` uses. */
export async function getInstallationToken(
  creds: Pick<GithubAppCredentials, "appId" | "privateKeyPem">,
  installationId: string,
): Promise<string | undefined> {
  const jwt = mintAppJwt(creds);
  const res = await githubRequest(`/app/installations/${encodeURIComponent(installationId)}/access_tokens`, jwt, { method: "POST" });
  if (!res.ok) return undefined;
  const body = (await res.json()) as { token?: string };
  return body.token;
}

export interface InstalledRepo {
  owner: string;
  repo: string;
}

/** The repo(s) this installation was granted -- one or many, whatever the
 * admin selected in GitHub's own install UI. */
export async function listInstallationRepos(installationToken: string): Promise<InstalledRepo[]> {
  const res = await githubRequest("/installation/repositories", installationToken);
  if (!res.ok) return [];
  const body = (await res.json()) as { repositories?: { name: string; owner: { login: string } }[] };
  return (body.repositories ?? []).map((r) => ({ owner: r.owner.login, repo: r.name }));
}

export async function getDefaultBranch(installationToken: string, owner: string, repo: string): Promise<string | undefined> {
  const res = await githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, installationToken);
  if (!res.ok) return undefined;
  const body = (await res.json()) as { default_branch?: string };
  return body.default_branch;
}

function encodeContentsPath(filePath: string): string {
  return filePath.split("/").map(encodeURIComponent).join("/");
}

export interface CommitFileResult {
  ok: boolean;
  error?: string;
}

/**
 * Contents API create-or-update (`PUT /repos/{owner}/{repo}/contents/{path}`),
 * straight to `branch` -- no PR, matching the confirmed "push straight to
 * the default branch" decision for this flow. Reads the file's current `sha`
 * first, since GitHub requires it for an update-in-place; a 404 there just
 * means "doesn't exist yet" (the expected case on first setup), not an
 * error.
 */
export async function commitFile(
  installationToken: string,
  owner: string,
  repo: string,
  filePath: string,
  content: string,
  branch: string,
  message: string,
): Promise<CommitFileResult> {
  const encodedPath = encodeContentsPath(filePath);
  const getRes = await githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`, installationToken);
  let sha: string | undefined;
  if (getRes.ok) {
    const existing = (await getRes.json()) as { sha?: string };
    sha = existing.sha;
  } else if (getRes.status !== 404) {
    return { ok: false, error: `failed to read existing ${filePath}: ${getRes.status}` };
  }

  const putRes = await githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}`, installationToken, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message,
      content: Buffer.from(content, "utf8").toString("base64"),
      branch,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!putRes.ok) return { ok: false, error: `failed to write ${filePath}: ${putRes.status}` };
  return { ok: true };
}

/**
 * Reads back a file's raw text via the Contents API, or `undefined` if it
 * doesn't exist (a 404) or can't be decoded -- used to merge into an
 * existing `.claude/settings.json` (another tool's hooks must survive)
 * rather than blindly overwriting it, mirroring `enforce-hooks.ts`'s
 * read-merge-write discipline for the local-disk path.
 */
export async function readFile(installationToken: string, owner: string, repo: string, filePath: string, branch: string): Promise<string | undefined> {
  const encodedPath = encodeContentsPath(filePath);
  const res = await githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`, installationToken);
  if (!res.ok) return undefined;
  const body = (await res.json()) as { content?: string; encoding?: string };
  if (!body.content || body.encoding !== "base64") return undefined;
  try {
    return Buffer.from(body.content, "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

/**
 * Exchanges the "request user authorization during installation" `code` for
 * a user access token -- identifies *who* installed the App, playing the
 * same role a device-flow token plays for `join.ts`/`join-via-github`, via
 * the App's own OAuth client id/secret (a GitHub App has its own, distinct
 * from the public device-flow OAuth App `join.ts`/the dashboard use).
 * `undefined` on any failure, same convention as the rest of this file.
 */
export async function exchangeUserCode(creds: Pick<GithubAppCredentials, "clientId" | "clientSecret">, code: string): Promise<string | undefined> {
  try {
    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: creds.clientId, client_secret: creds.clientSecret, code }),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { access_token?: string };
    return body.access_token;
  } catch {
    return undefined;
  }
}
