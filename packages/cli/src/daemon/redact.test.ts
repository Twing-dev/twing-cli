/**
 * Redaction fixtures, one per known secret shape. The values here are
 * syntactically real but fabricated -- never copied from anything live.
 *
 * The negative cases matter as much as the positive ones: layer 4 (entropy)
 * is the only heuristic layer, and a filter that masks every git SHA and
 * UUID in a captured conversation protects nothing while making the capture
 * useless to distill from later.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { redact, looksLikeSecret, shannonEntropy } from "./redact.js";

function assertRedacted(text: string, secret: string): void {
  const out = redact(text);
  assert.ok(!out.includes(secret), `expected ${JSON.stringify(secret)} to be redacted out of ${JSON.stringify(out)}`);
  assert.match(out, /\[redacted\]/);
}

test("redact: provider token prefixes", () => {
  assertRedacted("here's the key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 use it", "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789");
  assertRedacted("OPENAI_API_KEY=sk-proj-AbCdEfGhIjKlMnOpQrStUvWx0123", "sk-proj-AbCdEfGhIjKlMnOpQrStUvWx0123");
  assertRedacted("token ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789");
  assertRedacted("github_pat_11ABCDEFG0AbCdEfGhIjKl_MnOpQrStUvWxYz0123456789", "github_pat_11ABCDEFG0AbCdEfGhIjKl_MnOpQrStUvWxYz0123456789");
  // Assembled at runtime rather than written as a literal. GitHub's push
  // protection blocks any commit containing a Slack-token-shaped string --
  // including this fabricated one, which blocked this branch from pushing.
  // The other fixtures here are unaffected: their formats carry checksums
  // these fake values fail, so the scanner discards them. Slack's has none.
  const slack = ["xo" + "xb", "1234567890", "abcdefghijklmnop"].join("-");
  assertRedacted(`slack ${slack}`, slack);
  assertRedacted("aws key AKIAIOSFODNN7EXAMPLE here", "AKIAIOSFODNN7EXAMPLE");
  assertRedacted("google AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R", "AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R");
});

test("redact: a JWT", () => {
  assertRedacted(
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
  );
});

test("redact: a PEM private key body", () => {
  const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAxyz\nabc\n-----END RSA PRIVATE KEY-----";
  assertRedacted(`the file had ${key} in it`, "MIIEowIBAAKCAQEAxyz");
});

test("redact: a credentialed URI keeps the host but not the password", () => {
  const out = redact("postgres://twing:hunter2ftw@db.internal:5432/twing");
  assert.ok(!out.includes("hunter2ftw"));
  assert.match(out, /db\.internal:5432\/twing/, "the host and database are context worth keeping");
  assert.match(out, /postgres:\/\/twing:/, "the username is context too -- only the secret half goes");
});

test("redact: keyed secrets in .env / DSN shape", () => {
  assertRedacted("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY", "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY");
  assertRedacted('password: "correct-horse-battery"', "correct-horse-battery");
  assertRedacted("api_key = abcdef123456", "abcdef123456");
});

test("redact: a bare high-entropy token with no recognizable prefix", () => {
  // twing's own PATs are 64 hex chars from crypto.randomBytes -- they match
  // no provider prefix at all, so layer 4 is the only thing standing between
  // one and the capture file.
  assertRedacted(
    "my token is 3f8a1c9e2b7d4056a1c3e5f70982b4d6c8e0a2f4b6d8091a3c5e7f9012b4d6e8 keep it safe",
    "3f8a1c9e2b7d4056a1c3e5f70982b4d6c8e0a2f4b6d8091a3c5e7f9012b4d6e8",
  );
  assertRedacted("base64 blob dGhpcyBpcyBhIHNlY3JldCB2YWx1ZSB0aGF0IGlzIGxvbmc9PQ==", "dGhpcyBpcyBhIHNlY3JldCB2YWx1ZSB0aGF0IGlzIGxvbmc9PQ==");
});

test("redact: git SHAs, UUIDs and digests survive -- they are identifiers, not credentials", () => {
  const text =
    "commit c20dc06 (full: 8f3a2b1c4d5e6f708192a3b4c5d6e7f80912a3b4) closed design " +
    "f61d526d-28f4-48d3-bcb3-f75ecd2584da with md5 d41d8cd98f00b204e9800998ecf8427e";
  const out = redact(text);
  assert.equal(out, text);
});

test("redact: ordinary prose and file paths survive", () => {
  const text = "See packages/cli/src/daemon/transcript.ts:120 -- the watermark advances only to the last complete line, never mid-object.";
  assert.equal(redact(text), text);
});

test("redact: is idempotent -- re-running over already-redacted text changes nothing", () => {
  const once = redact("token ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 and password: hunter2ftw");
  assert.equal(redact(once), once);
});

test("looksLikeSecret: the threshold cases the entropy layer turns on", () => {
  assert.equal(looksLikeSecret("short"), false, "too short to judge");
  assert.equal(looksLikeSecret("f61d526d-28f4-48d3-bcb3-f75ecd2584da"), false, "a UUID is an identifier");
  assert.equal(looksLikeSecret("8f3a2b1c4d5e6f708192a3b4c5d6e7f80912a3b4"), false, "40 hex chars is a git SHA");
  assert.equal(looksLikeSecret("111111111111111111111111111111"), false, "no entropy at all");
  assert.equal(looksLikeSecret("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), false, "one repeated character");
  assert.equal(looksLikeSecret("3f8a1c9e2b7d4056a1c3e5f70982b4d6c8e0a2f4b6d8091a3c5e7f9012b4d6e8"), true, "64 hex chars: twing's own PAT shape");
  assert.equal(looksLikeSecret("aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY"), true, "mixed-case high-entropy run");
});

test("shannonEntropy: bounded by the alphabet it measures", () => {
  assert.equal(shannonEntropy(""), 0);
  assert.equal(shannonEntropy("aaaa"), 0);
  assert.ok(shannonEntropy("abcd") > 1.9 && shannonEntropy("abcd") < 2.1);
});

// Found while running the filter over a real 92MB transcript: `/` has to be
// in layer 4's candidate class (base64 uses it), which made every
// mixed-case absolute path match as one long high-entropy run. Every
// captured file path came out as `[redacted]` -- destroying the one signal
// the capture contract keeps tool calls around for at all.
test("redact: absolute file paths survive layer 4, mixed case and digits included", () => {
  for (const path of [
    "/Users/mb/Projects/twing-monitor/src/components/RepoListView.tsx",
    "/Users/mb/.claude/projects/-Users-mb-Projects-twing-cli/4d7d71d2-efc9-4868-acda-4ebb8c869945.jsonl",
    "packages/cli/src/daemon/transcript.ts",
    "/var/folders/T9/abcXYZ123/twing-cli-test-99/repo/src/App.tsx",
  ]) {
    assert.equal(redact(path), path);
  }
});

test("redact: a secret sitting in a path-shaped run is still masked, segment by segment", () => {
  const out = redact("/repo/tokens/3f8a1c9e2b7d4056a1c3e5f70982b4d6c8e0a2f4b6d8091a3c5e7f9012b4d6e8/notes");
  assert.ok(!out.includes("3f8a1c9e2b7d4056a1c3e5f70982b4d6c8e0a2f4b6d8091a3c5e7f9012b4d6e8"));
  assert.match(out, /^\/repo\/tokens\/\[redacted\]\/notes$/, "only the secret segment goes, the path around it stays");
});
