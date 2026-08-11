import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeServerUrl } from "./init.js";

// Found live, 2026-08-11: `--server host:port` (no scheme) failed deep
// inside fetch() with a cryptic parse error that got silently swallowed as
// "server unreachable," leaving `init` reporting "done" with a broken URL
// persisted to config.json.
test("normalizeServerUrl: adds http:// when no scheme is given", () => {
  assert.equal(normalizeServerUrl("15.235.199.203:8787"), "http://15.235.199.203:8787");
});

test("normalizeServerUrl: leaves an explicit http:// URL untouched", () => {
  assert.equal(normalizeServerUrl("http://15.235.199.203:8787"), "http://15.235.199.203:8787");
});

test("normalizeServerUrl: leaves an explicit https:// URL untouched", () => {
  assert.equal(normalizeServerUrl("https://twing.example.com"), "https://twing.example.com");
});

test("normalizeServerUrl: works with a bare hostname, no port", () => {
  assert.equal(normalizeServerUrl("localhost"), "http://localhost");
});

test("normalizeServerUrl: throws on genuinely unparseable input", () => {
  assert.throws(() => normalizeServerUrl("not a url at all :::"), /isn't a valid server URL/);
});
