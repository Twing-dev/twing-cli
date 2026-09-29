import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyTag, validateRelease } from "./release-policy.mjs";

function packages(version) {
  return { core: { version }, cli: { version, coreDependency: `^${version}` }, server: { version } };
}

function git({ ancestors = [], tags = [], files = [] } = {}) {
  return {
    isAncestor: (ancestor, descendant) => ancestors.some(([a, b]) => a === ancestor && b === descendant),
    mergedTags: () => tags,
    changedFiles: () => files,
  };
}

test("classifies supported release tags", () => {
  assert.deepEqual(classifyTag("v1.3.12-experimental.4"), { channel: "experimental", version: "1.3.12-experimental.4" });
  assert.deepEqual(classifyTag("v1.3.12"), { channel: "stable", version: "1.3.12" });
  assert.throws(() => classifyTag("v1.3.12-rc.1"), /not a supported release tag/);
});

test("experimental releases must come from main", () => {
  const version = "1.3.12-experimental.1";
  assert.deepEqual(validateRelease({ tag: `v${version}`, sha: "candidate", packages: packages(version), git: git({ ancestors: [["candidate", "origin/main"]] }) }), { channel: "experimental", version });
  assert.throws(() => validateRelease({ tag: `v${version}`, sha: "candidate", packages: packages(version), git: git() }), /must point at a commit on main/);
});

test("stable releases from main are rejected", () => {
  const version = "1.3.12";
  assert.throws(
    () => validateRelease({ tag: `v${version}`, sha: "main-release", packages: packages(version), git: git({ ancestors: [["main-release", "origin/release/1.3"], ["main-release", "origin/main"]] }) }),
    /points at main/,
  );
});

test("stable promotion permits metadata changes only", () => {
  const version = "1.3.12";
  const accepted = validateRelease({
    tag: `v${version}`,
    sha: "promotion",
    packages: packages(version),
    git: git({ ancestors: [["promotion", "origin/release/1.3"]], tags: ["v1.3.12-experimental.2"], files: ["package-lock.json", "packages/cli/package.json", "packages/core/package.json", "packages/server/package.json"] }),
  });
  assert.deepEqual(accepted, { channel: "stable", version, experimentalTag: "v1.3.12-experimental.2" });
  assert.throws(
    () => validateRelease({ tag: `v${version}`, sha: "promotion", packages: packages(version), git: git({ ancestors: [["promotion", "origin/release/1.3"]], tags: ["v1.3.12-experimental.2"], files: ["packages/cli/src/init.ts"] }) }),
    /changes code/,
  );
});
