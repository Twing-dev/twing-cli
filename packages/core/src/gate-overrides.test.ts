import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isGateDisabled, setGateDisabled } from "./gate-overrides.js";

function withIsolatedHome<T>(fn: () => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "twing-gate-overrides-test-"));
  const original = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env.HOME;
    else process.env.HOME = original;
  }
}

test("isGateDisabled: false when the overrides file doesn't exist at all", () => {
  withIsolatedHome(() => {
    assert.equal(isGateDisabled("proj-1"), false);
  });
});

test("setGateDisabled/isGateDisabled: round-trips true, scoped to that one project", () => {
  withIsolatedHome(() => {
    setGateDisabled("proj-1", true);
    assert.equal(isGateDisabled("proj-1"), true);
    assert.equal(isGateDisabled("proj-2"), false, "a different project must be unaffected");
  });
});

test("setGateDisabled(false): clears a prior disable rather than writing an explicit 'enabled' entry", () => {
  withIsolatedHome(() => {
    setGateDisabled("proj-1", true);
    setGateDisabled("proj-1", false);
    assert.equal(isGateDisabled("proj-1"), false);

    const overridesPath = path.join(os.homedir(), ".twing", "gate-overrides.json");
    const overrides = JSON.parse(fs.readFileSync(overridesPath, "utf8")) as Record<string, string>;
    assert.equal("proj-1" in overrides, false, "clearing must delete the key, not just set it falsy");
  });
});

test("setGateDisabled: multiple projects coexist independently", () => {
  withIsolatedHome(() => {
    setGateDisabled("proj-1", true);
    setGateDisabled("proj-2", true);
    setGateDisabled("proj-1", false);
    assert.equal(isGateDisabled("proj-1"), false);
    assert.equal(isGateDisabled("proj-2"), true);
  });
});

test("isGateDisabled: false for a malformed overrides file, not a crash", () => {
  withIsolatedHome(() => {
    const dir = path.join(os.homedir(), ".twing");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "gate-overrides.json"), "not json");
    assert.equal(isGateDisabled("proj-1"), false);
  });
});
