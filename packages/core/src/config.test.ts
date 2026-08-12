import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeServerUrl, parseConfig, getServerAuth, setServerAuth, type TwingConfig } from "./config.js";

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

// Multi-server support: serverUrl doubles as a `servers` map key now, not
// just a display string -- two spellings of the same server silently
// forking into two cached-token slots would be a real, confusing bug.
test("normalizeServerUrl: strips a single trailing slash", () => {
  assert.equal(normalizeServerUrl("http://localhost:8787/"), "http://localhost:8787");
});

test("normalizeServerUrl: no-scheme input with a trailing slash normalizes the same as with a scheme", () => {
  assert.equal(normalizeServerUrl("localhost:8787/"), normalizeServerUrl("http://localhost:8787/"));
});

test("parseConfig: migrates the old single-slot shape into the servers map", () => {
  const migrated = parseConfig({ serverUrl: "http://localhost:8787", authToken: "tok-a" });
  assert.deepEqual(migrated, { servers: { "http://localhost:8787": { authToken: "tok-a" } } });
});

test("parseConfig: migration normalizes the legacy serverUrl (adds scheme, strips trailing slash)", () => {
  const migrated = parseConfig({ serverUrl: "localhost:8787/", authToken: "tok-a" });
  assert.deepEqual(migrated, { servers: { "http://localhost:8787": { authToken: "tok-a" } } });
});

test("parseConfig: an empty legacy serverUrl migrates to an empty servers map", () => {
  assert.deepEqual(parseConfig({ serverUrl: "", authToken: "tok-a" }), { servers: {} });
});

test("parseConfig: leaves the new multi-server shape as-is", () => {
  const already: TwingConfig = { servers: { "http://a": { authToken: "x" }, "http://b": {} } };
  assert.deepEqual(parseConfig(already), already);
});

test("parseConfig: missing/malformed input becomes an empty servers map, not a crash", () => {
  assert.deepEqual(parseConfig(null), { servers: {} });
  assert.deepEqual(parseConfig({}), { servers: {} });
  assert.deepEqual(parseConfig("not an object"), { servers: {} });
});

test("getServerAuth/setServerAuth: round-trips a token for a server, keyed independently of other servers", () => {
  let config: TwingConfig = { servers: {} };
  config = setServerAuth(config, "http://a.example.com", { authToken: "tok-a" });
  config = setServerAuth(config, "http://b.example.com", { authToken: "tok-b" });

  assert.equal(getServerAuth(config, "http://a.example.com")?.authToken, "tok-a");
  assert.equal(getServerAuth(config, "http://b.example.com")?.authToken, "tok-b");
  assert.equal(getServerAuth(config, "http://c.example.com"), undefined);
});

test("getServerAuth/setServerAuth: normalize their serverUrl argument, so a trailing-slash variant still hits the same entry", () => {
  const config = setServerAuth({ servers: {} }, "http://a.example.com/", { authToken: "tok-a" });
  assert.equal(getServerAuth(config, "http://a.example.com")?.authToken, "tok-a");
});

test("setServerAuth: does not mutate the config it was given", () => {
  const original: TwingConfig = { servers: {} };
  setServerAuth(original, "http://a.example.com", { authToken: "tok-a" });
  assert.deepEqual(original, { servers: {} });
});
