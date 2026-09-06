import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseManifest, loadManifestFromFile, upsertCoordinatorServerUrl, twingConfigPath, captureEnabled } from "./manifest.js";

test("parseManifest: coordinator.serverUrl parses when present", () => {
  const manifest = parseManifest("coordinator:\n  serverUrl: http://localhost:8787\n");
  assert.equal(manifest.coordinator.serverUrl, "http://localhost:8787");
});

test("parseManifest: coordinator is empty (not an error) when the file has no coordinator section", () => {
  const manifest = parseManifest("constraints:\n  - text: x\n    scope: y\n");
  assert.deepEqual(manifest.coordinator, { serverUrl: undefined });
});

test("loadManifestFromFile: a missing file returns an empty manifest, including an empty coordinator", () => {
  const manifest = loadManifestFromFile("/definitely/does/not/exist/twing.yml");
  assert.deepEqual(manifest.coordinator, {});
});

function tmpTwingYamlPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twing-manifest-test-"));
  return twingConfigPath(dir);
}

test("upsertCoordinatorServerUrl: creates the file and writes coordinator.serverUrl when none exists yet", () => {
  const filePath = tmpTwingYamlPath();
  const result = upsertCoordinatorServerUrl(filePath, "http://localhost:8787");
  assert.equal(result.written, true);
  assert.equal(result.conflictingExisting, undefined);

  const reloaded = loadManifestFromFile(filePath);
  assert.equal(reloaded.coordinator.serverUrl, "http://localhost:8787");
});

test("upsertCoordinatorServerUrl: preserves existing constraints/comments when adding coordinator to an already-populated file", () => {
  const filePath = tmpTwingYamlPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    "# a real comment a human wrote\nconstraints:\n  - text: use the shared codec\n    scope: \"packages/**\"\n",
  );

  const result = upsertCoordinatorServerUrl(filePath, "http://localhost:8787");
  assert.equal(result.written, true);

  const rawAfter = fs.readFileSync(filePath, "utf8");
  assert.match(rawAfter, /a real comment a human wrote/);

  const reloaded = loadManifestFromFile(filePath);
  assert.equal(reloaded.coordinator.serverUrl, "http://localhost:8787");
  assert.equal(reloaded.constraints.length, 1);
  assert.equal(reloaded.constraints[0].text, "use the shared codec");
});

test("upsertCoordinatorServerUrl: re-running with the same serverUrl is a no-op (written: false, no conflict)", () => {
  const filePath = tmpTwingYamlPath();
  upsertCoordinatorServerUrl(filePath, "http://localhost:8787");
  const second = upsertCoordinatorServerUrl(filePath, "http://localhost:8787");
  assert.equal(second.written, false);
  assert.equal(second.conflictingExisting, undefined);
});

test("upsertCoordinatorServerUrl: refuses to overwrite a different already-committed serverUrl", () => {
  const filePath = tmpTwingYamlPath();
  upsertCoordinatorServerUrl(filePath, "http://old-server:8787");
  const result = upsertCoordinatorServerUrl(filePath, "http://new-server:8787");

  assert.equal(result.written, false);
  assert.equal(result.conflictingExisting, "http://old-server:8787");

  // The file itself must be untouched -- still the old value, not clobbered.
  const reloaded = loadManifestFromFile(filePath);
  assert.equal(reloaded.coordinator.serverUrl, "http://old-server:8787");
});

// `capture:` -- the repo-level switch for session conversation capture,
// and the only thing that turns it on. Opt-in (see `CaptureConfig`):
// installing an npm package must never silently start capturing
// conversation on someone's machine, so only a committed manifest somebody
// deliberately edited can consent to it.

test("parseManifest: capture.enabled parses when present", () => {
  assert.equal(parseManifest("capture:\n  enabled: false\n").capture.enabled, false);
  assert.equal(parseManifest("capture:\n  enabled: true\n").capture.enabled, true);
});

test("parseManifest: capture is empty (not an error) when the file has no capture section", () => {
  assert.deepEqual(parseManifest("coordinator:\n  serverUrl: http://localhost:8787\n").capture, { enabled: undefined });
});

test("parseManifest: a non-boolean capture.enabled is ignored rather than coerced", () => {
  assert.equal(parseManifest("capture:\n  enabled: yes-please\n").capture.enabled, undefined);
});

test("captureEnabled: only an explicit true enables it -- absent, empty and false are all off", () => {
  assert.equal(captureEnabled(parseManifest("capture:\n  enabled: true\n")), true);
  assert.equal(captureEnabled(parseManifest("")), false, "no capture block at all");
  assert.equal(captureEnabled(parseManifest("capture: {}\n")), false, "a capture block that says nothing");
  assert.equal(captureEnabled(parseManifest("capture:\n  enabled: false\n")), false);
  assert.equal(captureEnabled(parseManifest("capture:\n  enabled: yes-please\n")), false, "a typo must not read as consent");
});

test("loadManifestFromFile: a missing file returns an empty manifest, including an empty capture block", () => {
  assert.deepEqual(loadManifestFromFile("/definitely/does/not/exist/twing.yml").capture, {});
});
