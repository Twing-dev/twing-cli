/**
 * Which repo a repo-scoped command is about.
 *
 * Every `twing` command that names a project derives it from a directory:
 * `findRepoRoot(cwd)` up to a `.git`, then `computeProjectId(repoRoot)` off
 * that repo's origin. That is right whenever the caller is standing in the
 * repo, and silently wrong whenever they are not -- which is now the normal
 * case, not an exotic one. A session started above a repo (`cd ~/work &&
 * claude`) edits inside it while its cwd never enters it, and the gate's own
 * deny messages hand that session commands like `twing design resolve --id
 * ...` to run.
 *
 * `--server` looks like the fix and is not: it satisfies the coordinator
 * lookup, leaving the projectId still derived from cwd, so the command
 * cheerfully asks the right server about the wrong project. Found live
 * 2026-09-16 -- `design list --server <url>` from `~/Projects` printed
 * nothing and exited 0 while the repo one level down had seven designs, two
 * of them flagged.
 *
 * So: `-C <dir>` (git's spelling) chooses the directory, and this helper
 * makes the failure loud when it cannot be honoured.
 */

import { findRepoRoot, isGitRepo } from "@twing/core";

function scopeHint(dir: string): string {
  return `  Run twing from inside the repo, or point it at one: -C <path-to-repo>\n  (looked in ${dir})`;
}

/**
 * The git repo `cwd` is in, or a clear error naming `-C`.
 *
 * For commands that need to identify a project but not a coordinator --
 * anything that only computes a projectId.
 */
export function requireRepoRoot(cwd: string): string {
  const repoRoot = findRepoRoot(cwd);
  // `isGitRepo` (git's own answer) rather than the `existsSync(".git")` that
  // findRepoRoot walks on: the two disagree exactly where this matters, for
  // a directory carrying a `.git` that no longer is -- or never was -- a
  // repository. One such directory in $HOME silently captured every
  // out-of-repo resolution on this machine for a month.
  if (!isGitRepo(repoRoot)) {
    throw new Error(`twing: ${repoRoot} is not a git repository, so twing cannot tell which project you mean.\n${scopeHint(repoRoot)}`);
  }
  return repoRoot;
}

/**
 * Deliberately only the `.git` check, not a `.twing/twing.yml` one.
 *
 * Requiring a manifest here looked tidier and broke two real cases: `align`
 * has a no-coordinator git-diff fallback that is supposed to work in any
 * repo, and `design *` already reports a better-worded "no coordinator
 * configured for this repo" of its own further in. A repo that exists but
 * was never onboarded genuinely has no designs, so answering emptily for it
 * is honest -- unlike answering for a project id invented out of a directory
 * that is no repo at all, which is what this guard is for.
 */
