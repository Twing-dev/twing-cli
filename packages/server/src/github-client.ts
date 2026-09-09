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

export interface GithubUser {
  /** GitHub's numeric user id, stringified. Stable across renames, and
   * never reused -- which is why identity keys on it rather than on
   * `login`. */
  id: string;
  login: string;
}

/**
 * Resolves *who* a GitHub token belongs to, via `GET /user`.
 *
 * The companion to `fetchRepoPermissions`, and the piece that was missing:
 * twing used a developer's GitHub token to decide their *role* and then
 * discarded the account, keying identity on a client-supplied
 * `git config user.email` instead. That left the server unable to tell one
 * person's second machine from a stranger who guessed an email -- so it
 * refused both.
 *
 * Same error handling as `fetchRepoPermissions` deliberately: `undefined`
 * on any non-200, with no distinction worth surfacing further up. A caller
 * that cannot identify the account simply proceeds without a verified
 * identity, exactly as before this existed.
 */
export async function fetchGithubUser(githubToken: string): Promise<GithubUser | undefined> {
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        authorization: `Bearer ${githubToken}`,
        accept: "application/vnd.github+json",
        "user-agent": "twing-cli",
      },
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { id?: number; login?: string };
    if (typeof body.id !== "number" || !body.login) return undefined;
    return { id: String(body.id), login: body.login };
  } catch {
    return undefined; // network/parse failure is "no verified account", never a hard error
  }
}
