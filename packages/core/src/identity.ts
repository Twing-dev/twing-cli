/**
 * Project/developer identity, per design doc §8 — zero setup ceremony by
 * construction. Every developer's CLI/daemon computes these identically and
 * independently; there is no registration step and nothing to keep in sync.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as os from "node:os";

function git(args: string[], cwd: string): string | null {
  try {
    // stdio: pipe stdout (we read it), discard stderr -- every call site here
    // treats a git failure (no such remote, not a git repo, no commits yet)
    // as an expected, silent `null`, not a real error; without this override
    // git's own "fatal: ..." lands on our stderr anyway even though we
    // already handle the failure, e.g. a fresh repo with no `origin` remote
    // printing "fatal: No such remote 'origin'" on every getOriginRemoteUrl
    // call despite that being a normal, handled case (§17 Phase 3's no-remote
    // fallback).
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function readOrCreatePersistedId(idPath: string): string {
  if (fs.existsSync(idPath)) {
    const existing = fs.readFileSync(idPath, "utf8").trim();
    if (existing) return existing;
  }
  const generated = crypto.randomUUID();
  try {
    fs.mkdirSync(path.dirname(idPath), { recursive: true });
    fs.writeFileSync(idPath, generated);
  } catch {
    // Best-effort persistence; an ephemeral id for this run is still
    // correct, just not durable across processes.
  }
  return generated;
}

/**
 * Canonicalizes a git remote URL so equivalent clone forms hash to the same
 * `projectId` (§8) -- discovered live, 2026-08-11: two clones of the same
 * repo using `git@host:org/repo.git` (SSH) vs `https://host/org/repo.git`
 * computed *different* projectIds and never saw each other's claims or
 * designs at all. Must stay byte-for-byte equivalent to the Go port in
 * `hook/identity.go`'s `canonicalizeRemoteURL`, or this breaks the same way
 * again for whichever side drifts.
 */
export function canonicalizeRemoteUrl(url: string): string {
  let s = url.trim();

  // SCP-like SSH syntax: git@host:org/repo(.git) -> host/org/repo
  const scpMatch = s.match(/^[^@/]+@([^:/]+):(.+)$/);
  if (scpMatch) {
    s = `${scpMatch[1]}/${scpMatch[2]}`;
  } else {
    // scheme://[user@]host/path -> host/path (https, http, ssh, git, ...)
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?/i, "");
  }

  s = s.replace(/\.git$/i, "");
  s = s.replace(/\/+$/, "");

  // Hosts are case-insensitive, and GitHub-style paths route
  // case-insensitively too -- lowercase the whole thing rather than risk a
  // false negative (missed cross-session match) from an incidental case
  // difference between two clones.
  return s.toLowerCase();
}

/** `projectId = sha256(canonicalized git remote get-url origin)` (§8). */
export function computeProjectId(repoRoot: string): string {
  const remoteUrl = git(["remote", "get-url", "origin"], repoRoot);
  if (remoteUrl) {
    return crypto.createHash("sha256").update(canonicalizeRemoteUrl(remoteUrl)).digest("hex");
  }
  // Edge case (§8): no remote means no way to clone, so no cross-developer
  // coordination need by construction — a random id gitignored per-repo.
  return readOrCreatePersistedId(path.join(repoRoot, ".git", "twing-project-id"));
}

/** Suggests a `developerId` from `git config user.email` -- used only as
 * the default label offered at `twing keygen`/`admin bootstrap` time, and
 * by `align.ts`'s no-server git-diff fallback path (which never talks to a
 * server to verify anything against). Once registered, `developerId` is
 * server-issued and resolved from the authenticated PAT on every request
 * (§17.10 hardening) -- this local computation is no longer trusted as-is
 * for anything the server persists or acts on. */
export function computeDeveloperId(repoRoot: string): string {
  const email = git(["config", "user.email"], repoRoot);
  if (email) return email;
  return readOrCreatePersistedId(path.join(os.homedir(), ".twing", "id"));
}

export function computeBranch(repoRoot: string): string {
  return git(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot) ?? "unknown";
}

/** §17 Phase 3: the raw `origin` remote URL, exposed separately from
 * `computeProjectId` (which only ever needs the hashed/canonicalized form)
 * because `init.ts` needs the canonicalized-but-unhashed string to feed
 * `parseGithubOwnerRepo` below. `null` when there's no `origin` remote at
 * all -- same case `computeProjectId` falls back to a persisted random id
 * for. */
export function getOriginRemoteUrl(repoRoot: string): string | null {
  return git(["remote", "get-url", "origin"], repoRoot);
}

/**
 * §17 Phase 3: extracts `{owner, repo}` from a *canonicalized* remote URL
 * (i.e. already run through `canonicalizeRemoteUrl` above) when it's
 * GitHub-hosted, `undefined` otherwise -- a non-GitHub host, or the
 * no-remote random-id fallback case (never call this with anything but a
 * real canonicalized URL). Deliberately strict: exactly two path segments
 * after the host, or this returns `undefined` rather than guessing --
 * `canonicalizeRemoteUrl` already stripped `.git`/trailing slashes/case, so
 * a real GitHub repo URL always canonicalizes to exactly
 * `github.com/owner/repo`.
 */
export function parseGithubOwnerRepo(canonicalRemoteUrl: string): { owner: string; repo: string } | undefined {
  const match = canonicalRemoteUrl.match(/^github\.com\/([^/]+)\/([^/]+)$/);
  if (!match) return undefined;
  return { owner: match[1], repo: match[2] };
}

/** Combines `getOriginRemoteUrl` + `canonicalizeRemoteUrl` + `parseGithubOwnerRepo`
 * -- the one call every GitHub-verified-onboarding call site needs (`init.ts`'s
 * founding-time seed, and, as of the `init`-wired default join/found path,
 * `join.ts` and `init.ts`'s auth resolution too). `undefined` for a repo with
 * no `origin` remote or a non-GitHub one -- callers use that to skip the
 * GitHub path entirely (e.g. `init.ts` avoids ever popping the device-flow
 * browser prompt for a repo it can't possibly work on). */
export function githubBinding(repoRoot: string): { owner: string; repo: string } | undefined {
  const remoteUrl = getOriginRemoteUrl(repoRoot);
  return remoteUrl ? parseGithubOwnerRepo(canonicalizeRemoteUrl(remoteUrl)) : undefined;
}
