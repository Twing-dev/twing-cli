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
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
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

/** `developerId` defaults to `git config user.email` — a label, not a
 * credential (§8); the server never verifies it. */
export function computeDeveloperId(repoRoot: string): string {
  const email = git(["config", "user.email"], repoRoot);
  if (email) return email;
  return readOrCreatePersistedId(path.join(os.homedir(), ".twing", "id"));
}

export function computeBranch(repoRoot: string): string {
  return git(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot) ?? "unknown";
}
