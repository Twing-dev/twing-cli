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
}

interface JoinViaGithubResponseJSON {
  developerId?: string;
  role?: string;
  founded?: boolean;
  error?: string;
}

/**
 * Returns the resulting PAT (freshly minted, an already-cached one that was
 * just reused, or one attached to via an existing session) -- `init.ts`'s
 * default auth-resolution path (§17 Phase 3 GitHub-founding) uses this
 * return value directly rather than re-reading config, mirroring
 * `runKeygen`'s existing return-token convention.
 */
export async function runJoinGithub(options: JoinOptions): Promise<string> {
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

  const device = await requestDeviceCode();
  console.log(`twing join: go to ${device.verification_uri} and enter code: ${device.user_code}`);
  console.log("twing join: waiting for you to approve...");
  const githubToken = await pollForAccessToken(device.device_code, device.interval, device.expires_in);
  console.log("twing join: GitHub authorization confirmed");

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

  const res = await authFetch(
    `${normalizedServer}/v1/projects/${projectId}/join-via-github`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    existingToken,
  );
  const result = (await res.json().catch(() => ({}))) as JoinViaGithubResponseJSON;
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
  return twingToken ?? existingToken!;
}
