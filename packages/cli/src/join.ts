/**
 * `twing join --github` (§17 Phase 3): GitHub-repo-permission-verified
 * project join, deliberately a standalone top-level command -- not a flag
 * on `keygen`, and no invite code involved at any point. Reuses only
 * `keygen.ts`'s exported `generateToken`/`hashToken` (shared PAT-minting
 * mechanics every identity-creating path already shares, not something
 * invite-specific), and `auth.ts`'s server-resolution helper -- otherwise
 * structurally independent of the invite/keygen ceremony, per the plan.
 *
 * Auth against GitHub itself uses the OAuth **device flow** (the `gh auth
 * login`/`docker login` mechanism) -- no local redirect server, the right
 * shape for a CLI. The resulting GitHub token is used exactly once, for
 * the one call to `/v1/projects/:id/join-via-github` below, then
 * discarded: never cached, never written to `~/.twing/config.json` (only
 * the freshly-minted twing PAT is).
 */

import { execFileSync } from "node:child_process";
import { readConfig, writeConfig, getServerAuth, setServerAuth, normalizeServerUrl, authFetch, findRepoRoot, computeProjectId, computeDeveloperId, githubBinding } from "@twing/core";
import { generateToken, hashToken } from "./keygen.js";
import { resolveServerUrl } from "./auth.js";

/**
 * twing-cli's own registered GitHub OAuth App (device flow enabled, no
 * client secret needed -- device flow is a public-client flow by design).
 * The client id alone is not a secret; it identifies the app to GitHub's
 * authorization screen, nothing more.
 */
const GITHUB_CLIENT_ID = "Ov23liSaEt1UliMyahy6";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface AccessTokenResponse {
  access_token?: string;
  error?: string; // "authorization_pending" | "slow_down" | "expired_token" | "access_denied" | ...
  interval?: number;
}

async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const res = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    // repo scope -- needed to read permissions on private repos via
    // GET /repos/{owner}/{repo}; public_repo alone would silently break
    // that call for any private-repo project.
    body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: "repo" }),
  });
  if (!res.ok) {
    throw new Error(`twing join: GitHub device-code request failed (${res.status})`);
  }
  return (await res.json()) as DeviceCodeResponse;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls GitHub's token endpoint at `interval` (bumping on `slow_down`,
 * per GitHub's device-flow spec) until the user has approved the request
 * on GitHub's own verification page, or it expires/is denied.
 */
async function pollForAccessToken(deviceCode: string, intervalSeconds: number, expiresInSeconds: number): Promise<string> {
  const deadline = Date.now() + expiresInSeconds * 1000;
  let interval = intervalSeconds;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    const res = await fetch(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const body = (await res.json().catch(() => ({}))) as AccessTokenResponse;
    if (body.access_token) return body.access_token;
    if (body.error === "authorization_pending") continue;
    if (body.error === "slow_down") {
      interval = body.interval ?? interval + 5;
      continue;
    }
    throw new Error(`twing join: GitHub authorization failed (${body.error ?? res.statusText})`);
  }
  throw new Error("twing join: GitHub authorization timed out -- run `twing join --github` again");
}

export interface JoinOptions {
  cwd: string;
  server?: string;
  /** Zero-touch onboarding (`init --unattended`): no human is present, so
   * the device flow -- which blocks until someone approves in a browser --
   * is not an option. Resolve a GitHub token non-interactively or fail
   * cleanly. */
  unattended?: boolean;
}

/**
 * A GitHub token from the local `gh` CLI, if it's installed and
 * authenticated. This is the whole of twing's non-interactive auth story,
 * and it works because the coordinator treats `githubToken` as an opaque
 * bearer: it hands it straight to `fetchRepoPermissions` (`app.ts`) to read
 * this repo's permissions, and nothing binds it to twing's own
 * `GITHUB_CLIENT_ID`. So any token with repo read access does the job --
 * the same check, the same server-derived role, one less browser round
 * trip.
 *
 * Deliberately not `GITHUB_TOKEN`/`GH_TOKEN`: those are ambient in CI and
 * are frequently short-lived job tokens scoped to a *different* repo than
 * the one being edited, which would silently resolve the wrong permissions.
 * `gh auth token` is an explicit, user-established credential for the
 * machine's actual GitHub identity.
 *
 * Never throws -- a missing or unauthenticated `gh` is the common case, not
 * an error.
 */
export function githubTokenFromGhCli(): string | undefined {
  try {
    const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return token === "" ? undefined : token;
  } catch {
    return undefined;
  }
}

interface JoinViaGithubResponseJSON {
  developerId?: string;
  role?: string;
  founded?: boolean;
  error?: string;
}

export const JOIN_VIA_GITHUB_MAX_ATTEMPTS = 3;

/**
 * Retries the `/v1/projects/:id/join-via-github` call itself (coordinator
 * hiccup / transient network failure) without ever re-running the device
 * flow -- the already-obtained `githubToken` is reused across attempts
 * within this one call, since it's still valid for however long GitHub's
 * OAuth app grants it, and re-prompting the user to re-approve on GitHub
 * for what might just be a dropped connection would be needless friction.
 * A real 4xx (bad request, rejected/expired GitHub token, "already exists")
 * is not transient -- retrying it three times would just repeat the same
 * rejection, so only a 5xx or a network-level failure (`fetch` itself
 * throwing) triggers a retry.
 */
export async function postJoinViaGithub(
  normalizedServer: string,
  projectId: string,
  body: Record<string, string>,
  existingToken: string | undefined,
): Promise<{ res: Response; result: JoinViaGithubResponseJSON }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= JOIN_VIA_GITHUB_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await authFetch(
        `${normalizedServer}/v1/projects/${projectId}/join-via-github`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
        existingToken,
      );
      if (res.status < 500) {
        const result = (await res.json().catch(() => ({}))) as JoinViaGithubResponseJSON;
        return { res, result };
      }
      lastError = new Error(`coordinator returned ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    if (attempt < JOIN_VIA_GITHUB_MAX_ATTEMPTS) {
      const backoffMs = 500 * 2 ** (attempt - 1); // 500ms, then 1000ms
      console.log(
        `twing join: join-via-github call failed (attempt ${attempt}/${JOIN_VIA_GITHUB_MAX_ATTEMPTS}), retrying in ${backoffMs}ms...`,
      );
      await sleep(backoffMs);
    }
  }
  throw new Error(
    `twing join: join-via-github failed after ${JOIN_VIA_GITHUB_MAX_ATTEMPTS} attempts -- ` +
      `${lastError instanceof Error ? lastError.message : String(lastError)}. Your GitHub authorization already ` +
      "succeeded; this is the coordinator call failing, not the device flow -- check the coordinator is reachable " +
      "and run `twing join --github` again.",
  );
}

export interface JoinGithubResult {
  /** The resulting PAT (freshly minted, an already-cached one that was just
   * reused, or one attached to via an existing session) -- `init.ts`'s
   * default auth-resolution path (§17 Phase 3 GitHub-founding) uses this
   * directly rather than re-reading config, mirroring `runKeygen`'s
   * existing return-token convention. */
  token: string;
  /** Whether this call founded the project (vs. joining an
   * already-founded one). */
  founded: boolean;
  /** This caller's resulting twing role for the project, from the
   * coordinator's GitHub-permission-verified response -- `init.ts` uses
   * this (`role === "admin"`) to decide whether to auto-write the
   * install-enforcement hook. */
  role: string | undefined;
}

export async function runJoinGithub(options: JoinOptions): Promise<JoinGithubResult> {
  const repoRoot = findRepoRoot(options.cwd);
  const serverUrl = resolveServerUrl(options.cwd, options.server);
  if (!serverUrl) {
    throw new Error("twing join: no server URL given -- pass --server <url>, set TWING_SERVER, or run this from a repo whose .twing/twing.yml already declares a coordinator.");
  }
  const projectId = computeProjectId(repoRoot);
  // Always sent, not just on a first founding -- harmless (and ignored
  // server-side) once a project's binding is already on file, but required
  // for the founding branch, which has no stored binding yet to check
  // against. `undefined` for a non-GitHub-hosted repo; the route 400s
  // clearly on that rather than this command guessing an error message.
  const github = githubBinding(repoRoot);

  // Prefer a token the machine already has (`gh auth token`) over making
  // someone approve in a browser -- same permissions check, same
  // server-derived role, no interaction. The device flow stays the fallback
  // for machines without `gh`, and is the only option a human ever sees
  // prompted.
  let githubToken = githubTokenFromGhCli();
  if (githubToken) {
    console.log("twing join: using the GitHub token from `gh auth token` (no browser approval needed)");
  } else {
    if (options.unattended) {
      throw new Error(
        "twing join: no non-interactive GitHub credential available. The GitHub device flow needs a human to " +
          "approve in a browser, which an unattended run can't do. Install and authenticate the GitHub CLI " +
          "(`gh auth login`), then retry -- or run `twing init` yourself once, interactively.",
      );
    }
    const device = await requestDeviceCode();
    console.log(`twing join: go to ${device.verification_uri} and enter code: ${device.user_code}`);
    console.log("twing join: waiting for you to approve...");
    githubToken = await pollForAccessToken(device.device_code, device.interval, device.expires_in);
    console.log("twing join: GitHub authorization confirmed");
  }

  const normalizedServer = normalizeServerUrl(serverUrl);
  const config = readConfig();
  const existingToken = getServerAuth(config, normalizedServer)?.authToken;

  const body: Record<string, string> = { githubToken };
  if (github) {
    body.githubOwner = github.owner;
    body.githubRepo = github.repo;
  }
  let twingToken: string | undefined;
  if (!existingToken) {
    twingToken = generateToken();
    body.tokenHash = hashToken(twingToken);
    body.label = computeDeveloperId(repoRoot);
  }

  const { res, result } = await postJoinViaGithub(normalizedServer, projectId, body, existingToken);
  if (!res.ok || !result.developerId) {
    throw new Error(`twing join: failed -- ${result.error ?? res.statusText}`);
  }

  if (twingToken) {
    writeConfig(setServerAuth(config, normalizedServer, { authToken: twingToken }));
    console.log(`twing join: generated a new personal access token for ${result.developerId}.`);
    console.log(`twing join: ${twingToken}`);
    console.log("twing join: this is the only time it will be shown -- it's cached locally in ~/.twing/config.json.");
  } else {
    console.log(`twing join: attached this project to your existing PAT for ${result.developerId}.`);
  }
  console.log(
    result.founded
      ? `twing join: founded this project on ${normalizedServer} and joined as ${result.role} (verified via your GitHub repo permissions)`
      : `twing join: joined as ${result.role} (from your GitHub repo permissions)`,
  );
  return { token: twingToken ?? existingToken!, founded: result.founded ?? false, role: result.role };
}

/**
 * Attaches this machine's verified GitHub account to the identity it
 * already authenticates as.
 *
 * This is the migration, and it is why nobody has to run anything for it. A
 * machine that already holds a PAT also, almost always, has a `gh` token --
 * so a single authenticated call proves both halves at once and the
 * coordinator can link them. From then on *any other* machine this person
 * uses is recognised by the verified account instead of being refused with
 * "a developer identity for ... already exists", which is the wall that
 * blocked two real onboarding attempts.
 *
 * Deliberately quiet and deliberately non-fatal:
 *
 *  - Never runs the device flow. If `gh` has no token there is simply
 *    nothing to link, and interrupting a working `init` to ask for a
 *    browser approval would be a worse trade than staying unlinked.
 *  - Never throws. The caller is already authenticated and already
 *    working; a failed link costs a future convenience, not this run.
 *  - Says nothing on the common path (already linked, or nothing to do).
 *    The one thing worth printing is a *refusal*, which means this GitHub
 *    account is attached to a different twing identity -- a real situation
 *    a human has to resolve, not noise.
 */
export async function linkGithubIdentity(options: { cwd: string; server: string; authToken: string }): Promise<void> {
  try {
    const repoRoot = findRepoRoot(options.cwd);
    const github = githubBinding(repoRoot);
    if (!github) return;

    const githubToken = githubTokenFromGhCli();
    if (!githubToken) return;

    const { res, result } = await postJoinViaGithub(
      normalizeServerUrl(options.server),
      computeProjectId(repoRoot),
      { githubToken, githubOwner: github.owner, githubRepo: github.repo },
      options.authToken,
    );
    if (!res.ok && result.error) {
      console.log(`twing init: couldn't link your GitHub account -- ${result.error}`);
    }
  } catch {
    // Best-effort by design; see the doc comment.
  }
}
