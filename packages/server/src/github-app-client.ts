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
 *
 * **Every exported function here fails soft, never throws** -- a network-level
 * failure (DNS, TLS, timeout) is caught right at the `fetch` call, same as an
 * ordinary non-2xx response; `setUpOneRepoViaGithubApp` (`app.ts`) depends on
 * this to fold every failure into one repo's result rather than aborting the
 * whole multi-repo route with an unhandled rejection (found in review: only
 * `exchangeUserCode` actually had the try/catch this file's original doc
 * comment claimed for all of them).
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
 * (installation revoked mid-flow, bad credentials, etc.) or network-level
 * failure, same "caller treats every failure identically" convention
 * `github-client.ts` uses. */
export async function getInstallationToken(
  creds: Pick<GithubAppCredentials, "appId" | "privateKeyPem">,
  installationId: string,
): Promise<string | undefined> {
  try {
    const jwt = mintAppJwt(creds);
    const res = await githubRequest(`/app/installations/${encodeURIComponent(installationId)}/access_tokens`, jwt, { method: "POST" });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { token?: string };
    return body.token;
  } catch {
    return undefined;
  }
}

export interface InstalledRepo {
  owner: string;
  repo: string;
}

/** The repo(s) this installation was granted -- one or many, whatever the
 * admin selected in GitHub's own install UI. Paginates (`per_page=100`,
 * following pages until a short page ends it) -- an unpaginated single call
 * silently dropped everything past the API's default 30-per-page for an
 * "all repositories" install on a larger org, found in review. Best-effort
 * on a mid-pagination failure: returns whatever pages already succeeded
 * rather than discarding them, since a partial onboarding pass is strictly
 * better than none. */
export async function listInstallationRepos(installationToken: string): Promise<InstalledRepo[]> {
  const repos: InstalledRepo[] = [];
  try {
    for (let page = 1; ; page++) {
      const res = await githubRequest(`/installation/repositories?per_page=100&page=${page}`, installationToken);
      if (!res.ok) break;
      const body = (await res.json()) as { repositories?: { name: string; owner: { login: string } }[] };
      const batch = body.repositories ?? [];
      repos.push(...batch.map((r) => ({ owner: r.owner.login, repo: r.name })));
      if (batch.length < 100) break;
    }
  } catch {
    // Best-effort -- fall through to whatever pages already succeeded.
  }
  return repos;
}

export async function getDefaultBranch(installationToken: string, owner: string, repo: string): Promise<string | undefined> {
  try {
    const res = await githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, installationToken);
    if (!res.ok) return undefined;
    const body = (await res.json()) as { default_branch?: string };
    return body.default_branch;
  } catch {
    return undefined;
  }
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
 * the default branch" decision for this flow.
 *
 * `knownSha` lets a caller that already read the file (`readFile`, below)
 * skip this function's own pre-read entirely: omit it (or leave it
 * `undefined`) to have `commitFile` fetch the current sha itself, pass a
 * sha string when you already have one (an update), or pass `null` when
 * you've already confirmed the file doesn't exist (a create) -- distinct
 * from "didn't check," which still triggers the internal GET. Skipping a
 * redundant read isn't just an efficiency nicety here: fewer reads between
 * "what does this file currently say" and "write over it" narrows the
 * window for a stale-sha race against a concurrent external commit.
 */
export async function commitFile(
  installationToken: string,
  owner: string,
  repo: string,
  filePath: string,
  content: string,
  branch: string,
  message: string,
  knownSha?: string | null,
): Promise<CommitFileResult> {
  try {
    const encodedPath = encodeContentsPath(filePath);
    let sha: string | undefined;
    if (knownSha !== undefined) {
      sha = knownSha ?? undefined;
    } else {
      const getRes = await githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`, installationToken);
      if (getRes.ok) {
        const existing = (await getRes.json()) as { sha?: string };
        sha = existing.sha;
      } else if (getRes.status !== 404) {
        return { ok: false, error: `failed to read existing ${filePath}: ${getRes.status}` };
      }
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
  } catch (err) {
    return { ok: false, error: `network error writing ${filePath}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export type ReadFileResult =
  | { ok: true; content: string; sha: string }
  | { ok: false; notFound: true }
  | { ok: false; notFound: false };

/**
 * Reads back a file's raw text (and sha, so a caller that goes on to
 * `commitFile` can skip its own redundant pre-read) via the Contents API.
 *
 * `notFound` distinguishes "confirmed absent" (404) from every other kind of
 * failure (a transient 403/429/500, a network error, undecodable content) --
 * collapsing those together was a real bug, found in review: a caller that
 * can't tell "doesn't exist yet" from "couldn't check" has no way to avoid
 * treating a *transient read failure on an existing file* as if the file
 * were new, which for `.twing/twing.yml` specifically means generating and
 * committing a bare minimal document over one that may have had real
 * `constraints`/`require_human_review` sections -- silent data loss. Callers
 * here (`setUpOneRepoViaGithubApp`) must branch on `notFound` explicitly
 * rather than treating every `ok: false` the same way.
 */
export async function readFile(installationToken: string, owner: string, repo: string, filePath: string, branch: string): Promise<ReadFileResult> {
  try {
    const encodedPath = encodeContentsPath(filePath);
    const res = await githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`, installationToken);
    if (res.status === 404) return { ok: false, notFound: true };
    if (!res.ok) return { ok: false, notFound: false };
    const body = (await res.json()) as { content?: string; encoding?: string; sha?: string };
    if (!body.content || body.encoding !== "base64" || !body.sha) return { ok: false, notFound: false };
    return { ok: true, content: Buffer.from(body.content, "base64").toString("utf8"), sha: body.sha };
  } catch {
    return { ok: false, notFound: false };
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
