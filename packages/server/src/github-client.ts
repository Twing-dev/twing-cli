/**
 * §17 Phase 3: GitHub API client, following `llm-client.ts`'s established
 * shape -- this codebase deliberately has no SDK dependency for any
 * external API, plain `fetch` throughout. One function, one call: checks a
 * developer's own GitHub repo permissions server-side, against the raw
 * token they just proved control of via the CLI's device-flow login --
 * never trusts a client-supplied permissions/role claim, same principle
 * §17.10 hardening already established for `developerId`.
 */

export interface GithubRepoPermissions {
  pull: boolean;
  triage: boolean;
  push: boolean;
  maintain: boolean;
  admin: boolean;
}

/**
 * Calls `GET /repos/{owner}/{repo}` with the developer's own GitHub token
 * (never a server-wide credential) and returns its `permissions` object, or
 * `undefined` on any non-200 response (no access, repo doesn't exist, token
 * invalid/expired, rate-limited, etc.) -- the caller treats all of those
 * identically: "this token doesn't prove access to this repo," never a
 * distinction worth exposing further up.
 */
export async function fetchRepoPermissions(githubToken: string, owner: string, repo: string): Promise<GithubRepoPermissions | undefined> {
  const res = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
    headers: {
      authorization: `Bearer ${githubToken}`,
      accept: "application/vnd.github+json",
      "user-agent": "twing-cli",
    },
  });
  if (!res.ok) return undefined;
  const body = (await res.json()) as { permissions?: Partial<GithubRepoPermissions> };
  if (!body.permissions) return undefined;
  return {
    pull: body.permissions.pull ?? false,
    triage: body.permissions.triage ?? false,
    push: body.permissions.push ?? false,
    maintain: body.permissions.maintain ?? false,
    admin: body.permissions.admin ?? false,
  };
}
