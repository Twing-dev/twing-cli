import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalizeRemoteUrl, parseGithubOwnerRepo, getOriginRemoteUrl } from "./identity.js";

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
