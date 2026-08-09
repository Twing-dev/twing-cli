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

/** `projectId = sha256(git remote get-url origin)` (§8). */
export function computeProjectId(repoRoot: string): string {
  const remoteUrl = git(["remote", "get-url", "origin"], repoRoot);
  if (remoteUrl) {
    return crypto.createHash("sha256").update(remoteUrl).digest("hex");
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
