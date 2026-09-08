/**
 * `resolveProjectCoordinator` -- how the daemon learns which coordinators it
 * serves.
 *
 * This exists because of a deadlock, so that is what the tests are about:
 * the daemon used to learn a repo's coordinator only as a by-product of a
 * successful edit (`extractClaim`), which meant a machine whose edits were
 * all being *denied* never registered one -- and the version-mismatch
 * self-update that would have cleared the deny had no server to poll. See
 * the function's own doc comment.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveProjectCoordinator } from "./claims.js";
import { tmpRepo, addGithubRemote } from "../test-support.js";

test("resolveProjectCoordinator: resolves a repo's committed coordinator with no edit involved", () => {
  const repo = tmpRepo("https://coordination-server.twing.dev");
  addGithubRemote(repo, "acme", "widgets");

  const resolved = resolveProjectCoordinator(repo);
  assert.ok(resolved, "a repo carrying .twing/twing.yml must resolve");
  assert.equal(resolved.serverUrl, "https://coordination-server.twing.dev");
  assert.ok(resolved.projectId.length > 0);
});

test("resolveProjectCoordinator: resolves from a subdirectory, not just the repo root", () => {
  const repo = tmpRepo("https://coordination-server.twing.dev");
  addGithubRemote(repo, "acme", "widgets");
  const nested = path.join(repo, "packages", "core", "src");
  fs.mkdirSync(nested, { recursive: true });

  // `get_notices` carries the session's cwd, which is wherever the developer
  // happened to start Claude Code -- rarely the repo root.
  const resolved = resolveProjectCoordinator(nested);
  assert.equal(resolved?.serverUrl, "https://coordination-server.twing.dev");
  assert.equal(resolved?.projectId, resolveProjectCoordinator(repo)?.projectId, "same repo, same projectId");
});

test("resolveProjectCoordinator: null for a repo with no coordinator configured", () => {
  const repo = tmpRepo(); // a git repo, but twing was never set up here
  assert.equal(resolveProjectCoordinator(repo), null);
});

test("resolveProjectCoordinator: null outside a repo, rather than throwing", () => {
  // The daemon calls this on every SessionStart; a session started outside
  // any repo must be a quiet no-op, not an exception on the socket path.
  const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "twing-no-repo-"));
  assert.equal(resolveProjectCoordinator(notARepo), null);
});
