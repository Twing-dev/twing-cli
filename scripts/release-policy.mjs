import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const EXPERIMENTAL_TAG = /^v(\d+\.\d+\.\d+-experimental\.\d+)$/;
const STABLE_TAG = /^v(\d+\.\d+\.\d+)$/;
const PROMOTION_FILES = new Set(["package-lock.json", "packages/cli/package.json", "packages/core/package.json", "packages/server/package.json"]);

function fail(message) {
  throw new Error(`release policy: ${message}`);
}

export function classifyTag(tag) {
  const experimental = tag.match(EXPERIMENTAL_TAG);
  if (experimental) return { channel: "experimental", version: experimental[1] };
  const stable = tag.match(STABLE_TAG);
  if (stable) return { channel: "stable", version: stable[1] };
  fail(`${tag} is not a supported release tag`);
}

export function validateRelease({ tag, sha, packages, git }) {
  const { channel, version } = classifyTag(tag);
  for (const [name, pkg] of Object.entries(packages)) {
    if (pkg.version !== version) fail(`${name} declares ${pkg.version}, expected ${version}`);
  }
  if (packages.cli.coreDependency !== `^${version}`) fail(`@twing/cli depends on ${packages.cli.coreDependency}, expected ^${version}`);

  if (channel === "experimental") {
    if (!git.isAncestor(sha, "origin/main")) fail(`experimental tag ${tag} must point at a commit on main`);
    return { channel, version };
  }

  const [major, minor] = version.split(".");
  const releaseBranch = `origin/release/${major}.${minor}`;
  if (git.isAncestor(sha, "origin/main")) fail(`stable tag ${tag} points at main; promote it from ${releaseBranch} instead`);
  if (!git.isAncestor(sha, releaseBranch)) fail(`stable tag ${tag} must point at ${releaseBranch}`);
  const experimentalTag = git.mergedTags(sha, `v${version}-experimental.*`)[0];
  if (!experimentalTag) fail(`stable tag ${tag} has no accepted ${version}-experimental.* ancestor`);
  const changed = git.changedFiles(experimentalTag, sha);
  const unexpected = changed.filter((file) => !PROMOTION_FILES.has(file));
  if (unexpected.length > 0) fail(`stable promotion changes code after ${experimentalTag}: ${unexpected.join(", ")}`);
  if (changed.length === 0) fail(`stable tag ${tag} must include a version-promotion commit after ${experimentalTag}`);
  return { channel, version, experimentalTag };
}

function commandGit(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function gitApi() {
  return {
    isAncestor(ancestor, descendant) {
      try {
        execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    },
    mergedTags(sha, pattern) {
      return commandGit(["tag", "--merged", sha, "--list", pattern, "--sort=-version:refname"]).split("\n").filter(Boolean);
    },
    changedFiles(from, to) {
      return commandGit(["diff", "--name-only", from, to]).split("\n").filter(Boolean);
    },
  };
}

function packageVersions() {
  const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
  const core = read("packages/core/package.json");
  const cli = read("packages/cli/package.json");
  const server = read("packages/server/package.json");
  return {
    core: { version: core.version },
    cli: { version: cli.version, coreDependency: cli.dependencies?.["@twing/core"] },
    server: { version: server.version },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [tag, sha] = process.argv.slice(2);
  if (!tag || !sha) fail("usage: node scripts/release-policy.mjs <tag> <commit>");
  const result = validateRelease({ tag, sha, packages: packageVersions(), git: gitApi() });
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(result).map(([key, value]) => `${key}=${value}`).join("\n") + "\n");
  } else {
    console.log(JSON.stringify(result));
  }
}
