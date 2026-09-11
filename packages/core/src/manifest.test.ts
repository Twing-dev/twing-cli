import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseManifest, loadManifestFromFile, upsertCoordinatorServerUrl, twingConfigPath, captureEnabled, designActiveTtlMs, parseDuration } from "./manifest.js";
import { DEFAULT_DESIGN_ACTIVE_TTL_MS, MAX_DESIGN_ACTIVE_TTL_MS } from "./types.js";

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

test("parseDuration: accepts an integer with an s/m/h/d suffix and nothing else", () => {
  assert.equal(parseDuration("30s"), 30_000);
  assert.equal(parseDuration("90m"), 90 * 60_000);
  assert.equal(parseDuration("36h"), 36 * 60 * 60_000);
  assert.equal(parseDuration("7d"), 7 * 24 * 60 * 60_000);
  assert.equal(parseDuration(" 7d "), 7 * 24 * 60 * 60_000, "surrounding whitespace is a formatting accident, not a different value");
  assert.equal(parseDuration("7"), undefined, "a bare number has no unit -- guessing one is how a 7-day window becomes 7 minutes");
  assert.equal(parseDuration("7w"), undefined, "unsupported unit");
  assert.equal(parseDuration("1.5h"), undefined, "integers only");
  assert.equal(parseDuration("-7d"), undefined);
  assert.equal(parseDuration(""), undefined);
});

test("designActiveTtlMs: reads settings.designDormantAfter, and is undefined when the block says nothing", () => {
  assert.equal(designActiveTtlMs(parseManifest("settings:\n  designDormantAfter: 36h\n")), 36 * 60 * 60_000);
  assert.equal(designActiveTtlMs(parseManifest("")), undefined, "no settings block at all -- the coordinator's default applies");
  assert.equal(designActiveTtlMs(parseManifest("settings: {}\n")), undefined, "a settings block that says nothing");
});

test("designActiveTtlMs: an out-of-range or unparseable value is refused, never clamped", () => {
  assert.equal(designActiveTtlMs(parseManifest("settings:\n  designDormantAfter: 365d\n")), undefined, "past MAX -- an admin should find out it didn't take");
  assert.equal(designActiveTtlMs(parseManifest("settings:\n  designDormantAfter: 30s\n")), undefined, "below MIN");
  assert.equal(designActiveTtlMs(parseManifest("settings:\n  designDormantAfter: soon\n")), undefined);
  assert.equal(designActiveTtlMs(parseManifest(`settings:\n  designDormantAfter: ${MAX_DESIGN_ACTIVE_TTL_MS / (24 * 60 * 60_000)}d\n`)), MAX_DESIGN_ACTIVE_TTL_MS, "exactly MAX is in range");
});

test("parseManifest: an unquoted numeric designDormantAfter survives as text, so the accessor can reject it for having no unit", () => {
  const manifest = parseManifest("settings:\n  designDormantAfter: 7\n");
  assert.equal(manifest.settings.designDormantAfter, "7", "kept verbatim -- init compares against this literal to tell 'rejected' from 'absent'");
  assert.equal(designActiveTtlMs(manifest), undefined);
});

test("DEFAULT_DESIGN_ACTIVE_TTL_MS: a week, so an overnight or weekend gap doesn't dorm an active design", () => {
  assert.equal(DEFAULT_DESIGN_ACTIVE_TTL_MS, 7 * 24 * 60 * 60_000);
});
