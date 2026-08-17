import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalizeRemoteUrl, parseGithubOwnerRepo } from "./identity.js";

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
