/**
 * Two supported layouts, per how the two sessions should relate to each
 * other's git history:
 *
 * - worktree: one shared repo, two `git worktree` checkouts. Same .git,
 *   same origin remote -> identical projectId, closest to "two agents in
 *   the same repo" (e.g. two terminal tabs on one clone).
 * - clones: two fully independent `git init`s with the same origin remote
 *   URL (so projectId still matches) but nothing else shared -- closer to
 *   two developers on two separate machines.
 *
 * Neither ever touches twing-cli's own source -- both copy a fixture
 * project from simulator/fixtures/ into a scratch workspace directory.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export type WorkspaceMode = "worktree" | "clones";

export interface SessionWorkspace {
  label: "A" | "B";
  dir: string;
  developerEmail: string;
}

export interface WorkspaceSetup {
  mode: WorkspaceMode;
  sessions: [SessionWorkspace, SessionWorkspace];
}

const DEV_EMAIL = { A: "session-a@simulator.local", B: "session-b@simulator.local" } as const;

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fakeOriginUrl(runId: string): string {
  return `https://example.invalid/twing-simulator/${runId}.git`;
}

function commitFixture(dir: string, originUrl: string): void {
  git(["init", "-q", "-b", "main"], dir);
  git(["remote", "add", "origin", originUrl], dir);
  git(["add", "-A"], dir);
  git(["-c", "user.email=simulator@twing.dev", "-c", "user.name=twing-simulator", "commit", "-q", "-m", "initial fixture"], dir);
}

export function setupWorktreeMode(fixtureSrc: string, workDir: string, runId: string): WorkspaceSetup {
  const mainDir = path.join(workDir, "main");
  fs.mkdirSync(mainDir, { recursive: true });
  fs.cpSync(fixtureSrc, mainDir, { recursive: true });
  commitFixture(mainDir, fakeOriginUrl(runId));

  // Per-worktree config (git 2.20+) -- without this, `git config user.email`
  // set from inside a worktree writes to the *shared* repo config, and both
  // sessions would collide onto one developerId.
  git(["config", "extensions.worktreeConfig", "true"], mainDir);

  const aDir = path.join(workDir, "session-a");
  const bDir = path.join(workDir, "session-b");
  git(["worktree", "add", "-q", "-b", "session-a", aDir], mainDir);
  git(["worktree", "add", "-q", "-b", "session-b", bDir], mainDir);
  git(["config", "--worktree", "user.email", DEV_EMAIL.A], aDir);
  git(["config", "--worktree", "user.name", "Session A"], aDir);
  git(["config", "--worktree", "user.email", DEV_EMAIL.B], bDir);
  git(["config", "--worktree", "user.name", "Session B"], bDir);

  return {
    mode: "worktree",
    sessions: [
      { label: "A", dir: aDir, developerEmail: DEV_EMAIL.A },
      { label: "B", dir: bDir, developerEmail: DEV_EMAIL.B },
    ],
  };
}

export function setupClonesMode(fixtureSrc: string, workDir: string, runId: string): WorkspaceSetup {
  const originUrl = fakeOriginUrl(runId);
  const aDir = path.join(workDir, "session-a");
  const bDir = path.join(workDir, "session-b");

  for (const [dir, email, name] of [
    [aDir, DEV_EMAIL.A, "Session A"],
    [bDir, DEV_EMAIL.B, "Session B"],
  ] as const) {
    fs.mkdirSync(dir, { recursive: true });
    fs.cpSync(fixtureSrc, dir, { recursive: true });
    commitFixture(dir, originUrl);
    git(["config", "user.email", email], dir);
    git(["config", "user.name", name], dir);
  }

  return {
    mode: "clones",
    sessions: [
      { label: "A", dir: aDir, developerEmail: DEV_EMAIL.A },
      { label: "B", dir: bDir, developerEmail: DEV_EMAIL.B },
    ],
  };
}

export function setupWorkspace(mode: WorkspaceMode, fixtureSrc: string, workDir: string, runId: string): WorkspaceSetup {
  return mode === "worktree" ? setupWorktreeMode(fixtureSrc, workDir, runId) : setupClonesMode(fixtureSrc, workDir, runId);
}
