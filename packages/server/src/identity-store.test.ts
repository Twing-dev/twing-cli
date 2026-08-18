import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { IdentityStore } from "./identity-store.js";
import { createDb } from "./db/client.js";

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "twing-identity-test-"));
}

function readBootstrapToken(dir: string): string {
  return fs.readFileSync(path.join(dir, "bootstrap-token"), "utf8").trim();
}

test("IdentityStore: generates a bootstrap token file on first construction", () => {
  const dir = tmpDir();
  new IdentityStore(createDb({ dataDir: dir }), { dataDir: dir });
  assert.ok(fs.existsSync(path.join(dir, "bootstrap-token")));
});

test("IdentityStore: bootstrap succeeds with the right token, creates an org + admin, consumes the file", () => {
  const dir = tmpDir();
  const store = new IdentityStore(createDb({ dataDir: dir }), { dataDir: dir });
  const token = readBootstrapToken(dir);

  const result = store.bootstrap(token, "hash-of-alice-pat", "alice@example.com");
  assert.ok(!("error" in result));
  if ("error" in result) return;
  assert.equal(result.developerId, "alice@example.com");
  assert.ok(result.orgId);
  assert.equal(store.getOrgRole(result.orgId, "alice@example.com"), "admin");
  assert.ok(!fs.existsSync(path.join(dir, "bootstrap-token")), "bootstrap token file should be consumed");
});

test("IdentityStore: bootstrap rejects a wrong token", () => {
  const dir = tmpDir();
  const store = new IdentityStore(createDb({ dataDir: dir }), { dataDir: dir });
  const result = store.bootstrap("not-the-real-token", "hash", "alice@example.com");
  assert.deepEqual(result, { error: "invalid bootstrap token" });
});

test("IdentityStore: a second bootstrap (no pending token file) grants admin on the existing org, doesn't create a second one", () => {
  const dir = tmpDir();
  const store = new IdentityStore(createDb({ dataDir: dir }), { dataDir: dir });
  const token1 = readBootstrapToken(dir);
  const first = store.bootstrap(token1, "hash-alice", "alice@example.com");
  assert.ok(!("error" in first));

  // No pending bootstrap token anymore (consumed, org already exists) --
  // simulates the disaster-recovery path via regenerateBootstrapToken.
  const recoveryToken = store.regenerateBootstrapToken();
  const second = store.bootstrap(recoveryToken, "hash-bob", "bob@example.com");
  assert.ok(!("error" in second));
  if ("error" in first || "error" in second) return;
  assert.equal(first.orgId, second.orgId, "recovery bootstrap should reuse the existing org, not create a second one");
  assert.equal(store.getOrgRole(second.orgId, "bob@example.com"), "admin");
});

test("IdentityStore: recovery bootstrap for an already-known developer rotates their token instead of erroring", () => {
  const dir = tmpDir();
  const store = new IdentityStore(createDb({ dataDir: dir }), { dataDir: dir });
  const token1 = readBootstrapToken(dir);
  store.bootstrap(token1, sha256Hex("old-pat"), "alice@example.com");
  assert.equal(store.resolveToken("old-pat")?.developerId, "alice@example.com");

  const recoveryToken = store.regenerateBootstrapToken();
  const rotated = store.bootstrap(recoveryToken, sha256Hex("new-pat"), "alice@example.com");
  assert.ok(!("error" in rotated));
  assert.equal(store.resolveToken("old-pat"), undefined, "the old PAT should no longer work after rotation");
  assert.equal(store.resolveToken("new-pat")?.developerId, "alice@example.com");
});

test("IdentityStore: createInvite + redeemInvite (org scope, new developer) grants org membership", () => {
  const dir = tmpDir();
  const store = new IdentityStore(createDb({ dataDir: dir }), { dataDir: dir });
  const token = readBootstrapToken(dir);
  const admin = store.bootstrap(token, "hash-alice", "alice@example.com");
  assert.ok(!("error" in admin));
  if ("error" in admin) return;

  const invite = store.createInvite({ kind: "org", orgId: admin.orgId }, "member", "bob@example.com", "alice@example.com");
  const redeemed = store.redeemInvite(invite.code, { tokenHash: "hash-bob", label: "bob@example.com" });
  assert.deepEqual(redeemed, { developerId: "bob@example.com" });
  assert.equal(store.getOrgRole(admin.orgId, "bob@example.com"), "member");
});

test("IdentityStore: redeemInvite rejects an already-consumed invite", () => {
  const dir = tmpDir();
  const store = new IdentityStore(createDb({ dataDir: dir }), { dataDir: dir });
  const admin = store.bootstrap(readBootstrapToken(dir), "hash-alice", "alice@example.com");
  if ("error" in admin) throw new Error("bootstrap failed");

  const invite = store.createInvite({ kind: "org", orgId: admin.orgId }, "member", "bob@example.com", "alice@example.com");
  store.redeemInvite(invite.code, { tokenHash: "hash-bob", label: "bob@example.com" });
  const second = store.redeemInvite(invite.code, { tokenHash: "hash-carol", label: "carol@example.com" });
  assert.deepEqual(second, { error: "invite already used" });
});

test("IdentityStore: redeemInvite rejects an expired invite", () => {
  const dir = tmpDir();
  const store = new IdentityStore(createDb({ dataDir: dir }), { dataDir: dir });
  const admin = store.bootstrap(readBootstrapToken(dir), "hash-alice", "alice@example.com");
  if ("error" in admin) throw new Error("bootstrap failed");

  const invite = store.createInvite({ kind: "org", orgId: admin.orgId }, "member", "bob@example.com", "alice@example.com", -1);
  const result = store.redeemInvite(invite.code, { tokenHash: "hash-bob", label: "bob@example.com" });
  assert.deepEqual(result, { error: "invite expired" });
});

test("IdentityStore: redeemInvite for an already-known developerId attaches membership without creating a duplicate identity", () => {
  const dir = tmpDir();
  const store = new IdentityStore(createDb({ dataDir: dir }), { dataDir: dir });
  const admin = store.bootstrap(readBootstrapToken(dir), "hash-alice", "alice@example.com");
  if ("error" in admin) throw new Error("bootstrap failed");

  const invite = store.createInvite({ kind: "org", orgId: admin.orgId }, "member", "alice@example.com", "alice@example.com");
  const result = store.redeemInvite(invite.code, { developerId: "alice@example.com" });
  assert.deepEqual(result, { developerId: "alice@example.com" });
  assert.equal(store.listDevelopers().filter((d) => d.developerId === "alice@example.com").length, 1);
});

test("IdentityStore: foundProject attaches to the founder's org, grants them project admin", () => {
  const dir = tmpDir();
  const store = new IdentityStore(createDb({ dataDir: dir }), { dataDir: dir });
  const admin = store.bootstrap(readBootstrapToken(dir), "hash-alice", "alice@example.com");
  if ("error" in admin) throw new Error("bootstrap failed");

  const record = store.foundProject("proj-1", "alice@example.com");
  assert.ok(!("error" in record));
  if ("error" in record) return;
  assert.equal(record.orgId, admin.orgId);
  assert.equal(store.getProjectRole("proj-1", "alice@example.com"), "admin");
  assert.equal(store.isProjectFounded("proj-1"), true);
});

// §17 Phase 3
test("IdentityStore: foundProject persists an optional GitHub binding, retrievable via getProjectRecord", () => {
  const dir = tmpDir();
  const store = new IdentityStore(createDb({ dataDir: dir }), { dataDir: dir });
  const admin = store.bootstrap(readBootstrapToken(dir), "hash-alice", "alice@example.com");
  if ("error" in admin) throw new Error("bootstrap failed");

  store.foundProject("proj-1", "alice@example.com", { owner: "twing-dev", repo: "twing-cli" });
  const record = store.getProjectRecord("proj-1");
  assert.equal(record?.githubOwner, "twing-dev");
  assert.equal(record?.githubRepo, "twing-cli");
});

test("IdentityStore: foundProject without a GitHub binding leaves it undefined, not null/empty-string", () => {
  const dir = tmpDir();
  const store = new IdentityStore(createDb({ dataDir: dir }), { dataDir: dir });
  const admin = store.bootstrap(readBootstrapToken(dir), "hash-alice", "alice@example.com");
  if ("error" in admin) throw new Error("bootstrap failed");

  store.foundProject("proj-1", "alice@example.com");
  const record = store.getProjectRecord("proj-1");
  assert.equal(record?.githubOwner, undefined);
  assert.equal(record?.githubRepo, undefined);
});

test("IdentityStore: joinProject mints a new developer identity and grants project + org member roles", () => {
  const dir = tmpDir();
  const store = new IdentityStore(createDb({ dataDir: dir }), { dataDir: dir });
  const admin = store.bootstrap(readBootstrapToken(dir), "hash-alice", "alice@example.com");
  if ("error" in admin) throw new Error("bootstrap failed");
  store.foundProject("proj-1", "alice@example.com", { owner: "twing-dev", repo: "twing-cli" });

  const result = store.joinProject("proj-1", "member", { tokenHash: "hash-bob", label: "bob@example.com" });
  assert.ok(!("error" in result));
  if ("error" in result) return;
  assert.equal(result.developerId, "bob@example.com");
  assert.equal(store.getProjectRole("proj-1", "bob@example.com"), "member");
  assert.equal(store.getOrgRole(admin.orgId, "bob@example.com"), "member");
});

test("IdentityStore: joinProject with an already-known developerId attaches membership without creating a duplicate identity", () => {
  const dir = tmpDir();
  const store = new IdentityStore(createDb({ dataDir: dir }), { dataDir: dir });
  const admin = store.bootstrap(readBootstrapToken(dir), "hash-alice", "alice@example.com");
  if ("error" in admin) throw new Error("bootstrap failed");
  store.foundProject("proj-1", "alice@example.com", { owner: "twing-dev", repo: "twing-cli" });
  store.foundProject("proj-2", "alice@example.com", { owner: "twing-dev", repo: "other-repo" });
  store.joinProject("proj-2", "member", { tokenHash: "hash-bob", label: "bob@example.com" });

  const result = store.joinProject("proj-1", "admin", { developerId: "bob@example.com" });
  assert.ok(!("error" in result));
  if ("error" in result) return;
  assert.equal(result.developerId, "bob@example.com");
  assert.equal(store.getProjectRole("proj-1", "bob@example.com"), "admin");
});

test("IdentityStore: redeemInvite/joinProject/foundProjectViaGithub all point at the real recovery path when a label collides with an existing identity", () => {
  const dir = tmpDir();
  const store = new IdentityStore(createDb({ dataDir: dir }), { dataDir: dir });
  const admin = store.bootstrap(readBootstrapToken(dir), "hash-alice", "alice@example.com");
  if ("error" in admin) throw new Error("bootstrap failed");
  store.foundProject("proj-1", "alice@example.com", { owner: "twing-dev", repo: "twing-cli" });

  // join-via-github joining an already-founded project, under a label that
  // already has an identity (lost/never-had PAT is the realistic case) --
  // the scenario task #93 is specifically about.
  const joinResult = store.joinProject("proj-1", "member", { tokenHash: "hash-new", label: "alice@example.com" });
  assert.ok("error" in joinResult);
  if (!("error" in joinResult)) return;
  assert.match(joinResult.error, /already exists/);
  assert.match(joinResult.error, /twing serve --regenerate-bootstrap-token/);
  assert.match(joinResult.error, /twing admin bootstrap --token/);

  // join-via-github *founding* a brand-new project, same label collision.
  const foundResult = store.foundProjectViaGithub("proj-2", { tokenHash: "hash-new2", label: "alice@example.com" }, { owner: "twing-dev", repo: "other-repo" });
  assert.ok("error" in foundResult);
  if (!("error" in foundResult)) return;
  assert.match(foundResult.error, /already exists/);
  assert.match(foundResult.error, /twing serve --regenerate-bootstrap-token/);

  // Same collision via the older invite-redemption path -- shares the exact
  // same underlying problem and fix, so it gets the same message.
  const invite = store.createInvite({ kind: "org", orgId: admin.orgId }, "member", "alice@example.com", "alice@example.com");
  const inviteResult = store.redeemInvite(invite.code, { tokenHash: "hash-new3", label: "alice@example.com" });
  assert.ok("error" in inviteResult);
  if (!("error" in inviteResult)) return;
  assert.match(inviteResult.error, /already exists/);
  assert.match(inviteResult.error, /twing serve --regenerate-bootstrap-token/);
});

test("IdentityStore: joinProject rejects an unknown projectId", () => {
  const dir = tmpDir();
  const store = new IdentityStore(createDb({ dataDir: dir }), { dataDir: dir });
  const result = store.joinProject("no-such-project", "member", { tokenHash: "hash-bob", label: "bob@example.com" });
  assert.deepEqual(result, { error: "no such project" });
});

test("IdentityStore: founding an already-founded project fails", () => {
  const dir = tmpDir();
  const store = new IdentityStore(createDb({ dataDir: dir }), { dataDir: dir });
  const admin = store.bootstrap(readBootstrapToken(dir), "hash-alice", "alice@example.com");
  if ("error" in admin) throw new Error("bootstrap failed");

  store.foundProject("proj-1", "alice@example.com");
  const second = store.foundProject("proj-1", "alice@example.com");
  assert.deepEqual(second, { error: "project already founded" });
});

test("IdentityStore: founding by a developer with no org membership fails", () => {
  const dir = tmpDir();
  const store = new IdentityStore(createDb({ dataDir: dir }), { dataDir: dir });
  const result = store.foundProject("proj-1", "nobody@example.com");
  assert.deepEqual(result, { error: "founder has no organization membership" });
});

test("IdentityStore: redeeming a project invite for a new developer auto-grants org membership too", () => {
  const dir = tmpDir();
  const store = new IdentityStore(createDb({ dataDir: dir }), { dataDir: dir });
  const admin = store.bootstrap(readBootstrapToken(dir), "hash-alice", "alice@example.com");
  if ("error" in admin) throw new Error("bootstrap failed");
  store.foundProject("proj-1", "alice@example.com");

  const invite = store.createInvite({ kind: "project", projectId: "proj-1" }, "member", "bob@example.com", "alice@example.com");
  const result = store.redeemInvite(invite.code, { tokenHash: "hash-bob", label: "bob@example.com" });
  assert.deepEqual(result, { developerId: "bob@example.com" });
  assert.equal(store.getProjectRole("proj-1", "bob@example.com"), "member");
  assert.equal(store.getOrgRole(admin.orgId, "bob@example.com"), "member", "project membership should auto-ensure an org membership row");
});

test("IdentityStore: resolveToken resolves the correct plaintext PAT to the right identity, with org and project roles", () => {
  const dir = tmpDir();
  const store = new IdentityStore(createDb({ dataDir: dir }), { dataDir: dir });
  const plaintext = "alices-real-pat";
  const admin = store.bootstrap(readBootstrapToken(dir), sha256Hex(plaintext), "alice@example.com");
  if ("error" in admin) throw new Error("bootstrap failed");
  store.foundProject("proj-1", "alice@example.com");

  const resolved = store.resolveToken(plaintext);
  assert.equal(resolved?.developerId, "alice@example.com");
  assert.deepEqual(resolved?.orgs, [{ orgId: admin.orgId, role: "admin" }]);
  assert.deepEqual(resolved?.projects, [{ projectId: "proj-1", orgId: admin.orgId, role: "admin" }]);
});

test("IdentityStore: resolveToken returns undefined for a token that doesn't hash to any stored PAT", () => {
  const dir = tmpDir();
  const store = new IdentityStore(createDb({ dataDir: dir }), { dataDir: dir });
  const admin = store.bootstrap(readBootstrapToken(dir), sha256Hex("alices-real-pat"), "alice@example.com");
  if ("error" in admin) throw new Error("bootstrap failed");

  assert.equal(store.resolveToken("some-other-guess"), undefined);
});

test("IdentityStore: revokeDeveloper removes the identity and cascades memberships", () => {
  const dir = tmpDir();
  const store = new IdentityStore(createDb({ dataDir: dir }), { dataDir: dir });
  const admin = store.bootstrap(readBootstrapToken(dir), "hash-alice", "alice@example.com");
  if ("error" in admin) throw new Error("bootstrap failed");
  store.foundProject("proj-1", "alice@example.com");

  const revoked = store.revokeDeveloper("alice@example.com");
  assert.equal(revoked, true);
  assert.equal(store.getOrgRole(admin.orgId, "alice@example.com"), undefined);
  assert.equal(store.getProjectRole("proj-1", "alice@example.com"), undefined);
  assert.equal(store.revokeDeveloper("alice@example.com"), false, "revoking again should report nothing to revoke");
});

test("IdentityStore: revokeInvite removes a pending invite so redemption then fails", () => {
  const dir = tmpDir();
  const store = new IdentityStore(createDb({ dataDir: dir }), { dataDir: dir });
  const admin = store.bootstrap(readBootstrapToken(dir), "hash-alice", "alice@example.com");
  if ("error" in admin) throw new Error("bootstrap failed");

  const invite = store.createInvite({ kind: "org", orgId: admin.orgId }, "member", "bob@example.com", "alice@example.com");
  assert.equal(store.revokeInvite(invite.code), true);
  const result = store.redeemInvite(invite.code, { tokenHash: "hash-bob", label: "bob@example.com" });
  assert.deepEqual(result, { error: "invite not found" });
});

test("IdentityStore: state persists across instances pointed at the same dataDir", () => {
  const dir = tmpDir();
  const store1 = new IdentityStore(createDb({ dataDir: dir }), { dataDir: dir });
  const admin = store1.bootstrap(readBootstrapToken(dir), "hash-alice", "alice@example.com");
  if ("error" in admin) throw new Error("bootstrap failed");
  store1.foundProject("proj-1", "alice@example.com");

  const store2 = new IdentityStore(createDb({ dataDir: dir }), { dataDir: dir });
  assert.equal(store2.getOrgRole(admin.orgId, "alice@example.com"), "admin");
  assert.equal(store2.getProjectRole("proj-1", "alice@example.com"), "admin");
});
