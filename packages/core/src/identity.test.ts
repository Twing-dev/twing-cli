import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalizeRemoteUrl, parseGithubOwnerRepo, getOriginRemoteUrl, computeProjectId } from "./identity.js";

// Fixture table shared conceptually with hook/identity_test.go -- both must
// canonicalize every one of these to the same string, or projectId diverges
// across languages the same way it diverged across SSH/HTTPS clones in
// production (2026-08-11).
const EQUIVALENT_FORMS = [
  "git@github.com:Org/Repo.git",
  "https://github.com/Org/Repo.git",
  "https://github.com/Org/Repo",
  "https://github.com/Org/Repo/",
  "ssh://git@github.com/Org/Repo.git",
  "http://github.com/Org/Repo.git",
];

test("canonicalizeRemoteUrl: all equivalent clone forms produce the same result", () => {
  const results = EQUIVALENT_FORMS.map(canonicalizeRemoteUrl);
  const [first, ...rest] = results;
  for (const r of rest) {
    assert.equal(r, first);
  }
  assert.equal(first, "github.com/org/repo");
});

test("canonicalizeRemoteUrl: different repos stay different", () => {
  assert.notEqual(canonicalizeRemoteUrl("git@github.com:Org/Repo.git"), canonicalizeRemoteUrl("git@github.com:Org/OtherRepo.git"));
});

test("canonicalizeRemoteUrl: self-hosted git over ssh with a custom port-like path still normalizes the scp form", () => {
  assert.equal(canonicalizeRemoteUrl("git@gitlab.example.com:group/sub/repo.git"), "gitlab.example.com/group/sub/repo");
});

// §17 Phase 3
test("parseGithubOwnerRepo: extracts owner/repo from a canonicalized GitHub URL", () => {
  assert.deepEqual(parseGithubOwnerRepo(canonicalizeRemoteUrl("git@github.com:Org/Repo.git")), { owner: "org", repo: "repo" });
  assert.deepEqual(parseGithubOwnerRepo("github.com/twing-dev/twing-cli"), { owner: "twing-dev", repo: "twing-cli" });
});

test("parseGithubOwnerRepo: undefined for a non-GitHub host", () => {
  assert.equal(parseGithubOwnerRepo(canonicalizeRemoteUrl("git@gitlab.example.com:group/repo.git")), undefined);
});

test("parseGithubOwnerRepo: undefined for a malformed/incomplete GitHub path", () => {
  assert.equal(parseGithubOwnerRepo("github.com/just-an-org"), undefined);
  assert.equal(parseGithubOwnerRepo("github.com/org/repo/extra"), undefined);
});

// A repo with no `origin` remote is a normal, handled case (§17 Phase 3's
// A directory with no `.git` at all reaches the no-remote branch the same
// way a real repo without an origin does -- findRepoRoot hands back its own
// argument when the walk finds nothing -- and used to be given a freshly
// minted random id, which callers then queried the coordinator with. Found
// live 2026-09-16: `design list --server <url>` one directory above a repo
// answered "no designs", exit 0, a different invented id every call.
test("computeProjectId: refuses to invent an id for a directory that is not a repo", () => {
  const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "twing-identity-not-a-repo-"));
  try {
    assert.throws(() => computeProjectId(notARepo), /not a git repository[\s\S]*-C <path-to-repo>/);
    assert.equal(fs.existsSync(path.join(notARepo, ".git", "twing-project-id")), false, "and writes nothing");
  } finally {
    fs.rmSync(notARepo, { recursive: true, force: true });
  }
});

// How the phantom repo got made, and why it survived: a twing command run
// outside any repo resolved a root of $HOME, the no-remote fallback created
// $HOME/.git to hold its id, and every findRepoRoot walk from anywhere under
// $HOME stopped there from then on -- a directory that is not a repository
// but satisfies every existsSync(".git") check. Found on this developer's
// machine 2026-09-16, dated 2026-08-17.
test("computeProjectId: never conjures a .git directory, and rejects a stray one", () => {
  const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "twing-identity-phantom-"));
  try {
    assert.throws(() => computeProjectId(notARepo), /not a git repository/);
    assert.equal(fs.existsSync(path.join(notARepo, ".git")), false, "must not create .git");

    // And the shape that actually bit: a .git that exists but is not a repo.
    fs.mkdirSync(path.join(notARepo, ".git"));
    assert.throws(() => computeProjectId(notARepo), /not a git repository/, "a stray .git is not a repo, whatever existsSync says");
    assert.equal(fs.existsSync(path.join(notARepo, ".git", "twing-project-id")), false, "and nothing is written into it");
  } finally {
    fs.rmSync(notARepo, { recursive: true, force: true });
  }
});

test("computeProjectId: a real repo with no origin still gets its persisted id", () => {
  // The fallback this guard must not break: no remote means no way to clone,
  // so a gitignored random id per repo is correct (§8).
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "twing-identity-no-remote-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: repoRoot });
    const first = computeProjectId(repoRoot);
    assert.match(first, /^[0-9a-f-]{36}$/);
    assert.equal(computeProjectId(repoRoot), first, "and it is stable across calls");
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

// no-remote fallback) -- git's own "fatal/error: No such remote 'origin'"
// isn't a real error here and shouldn't leak anywhere just because we
// happen to shell out to git to find that out (found live, 2026-08-18).
// This has to run getOriginRemoteUrl in a *child* process and inspect
// *that* child's stderr fd -- `execFileSync`'s default stdio duplicates the
// grandchild git process's stderr straight onto our fd 2, bypassing
// `process.stderr.write()`/anything else at the JS layer entirely, so
// nothing short of a real subprocess boundary can observe (or fail to
// observe) the leak this test exists to catch.
test("getOriginRemoteUrl: returns null and leaks nothing onto stderr for a repo with no origin remote", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "twing-identity-test-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: repoRoot });
    const distDir = path.dirname(new URL(import.meta.url).pathname); // this test file's own compiled location, dist/ (tests run against dist, not src)
    const modulePath = path.join(distDir, "identity.js");
    const script = `
      import(${JSON.stringify(modulePath)}).then(({ getOriginRemoteUrl }) => {
        process.stdout.write(JSON.stringify(getOriginRemoteUrl(${JSON.stringify(repoRoot)})));
      });
    `;
    const child = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
    assert.equal(child.stderr, "");
    assert.equal(child.stdout.trim(), "null");
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
