import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { requireRepoRoot } from "./repo-scope.js";
import { tmpRepo } from "./test-support.js";

function plainDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "twing-not-a-repo-"));
}

test("requireRepoRoot: a repo resolves, from the root and from below it", () => {
  const repo = tmpRepo("http://localhost:8787");
  const nested = path.join(repo, "packages", "api");
  fs.mkdirSync(nested, { recursive: true });

  assert.equal(requireRepoRoot(repo), repo);
  assert.equal(requireRepoRoot(nested), repo, "any depth inside the repo is the same repo");
});

test("requireRepoRoot: a directory that is no repo fails, naming -C", () => {
  // The whole point. This used to sail through to computeProjectId, which
  // minted a random id for a project that never existed, and the command
  // reported "nothing found" with a clean exit.
  assert.throws(() => requireRepoRoot(plainDir()), /not a git repository[\s\S]*-C <path-to-repo>/);
});

test("requireRepoRoot: a stray .git directory is not a repo", () => {
  // The case that made this necessary: $HOME/.git existed holding nothing but
  // twing's own project-id file, so findRepoRoot's existsSync walk stopped
  // there and every command run outside a repo was silently attributed to a
  // project that had never existed.
  const dir = plainDir();
  fs.mkdirSync(path.join(dir, ".git"));
  fs.writeFileSync(path.join(dir, ".git", "twing-project-id"), "d83eaca7-028b-4873-9158-2fdf76d6775b");

  assert.throws(() => requireRepoRoot(dir), /not a git repository[\s\S]*-C <path-to-repo>/);
});

test("requireRepoRoot: a git repo nobody onboarded still resolves", () => {
  // Only the .git check lives here: an un-onboarded repo genuinely has no
  // designs, and `design *` has its own better-worded coordinator error.
  const repo = tmpRepo();
  assert.equal(requireRepoRoot(repo), repo);
});
