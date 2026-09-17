/**
 * `managed-delegate.ts` -- when an outside copy of twing hands a command to
 * `~/.twing/lib`. Getting this wrong either way is silent: a missed hand-off
 * runs a version the coordinator didn't pick, a wrong one hijacks a
 * contributor's own build.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { managedDelegateTarget } from "./managed-delegate.js";

function managedHome(opts: { marker?: boolean; lib?: boolean } = {}): { home: string; target: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "twing-delegate-home-"));
  const target = path.join(home, ".twing", "lib", "node_modules", "@twing", "cli", "dist", "index.js");
  if (opts.marker ?? true) {
    fs.mkdirSync(path.join(home, ".twing"), { recursive: true });
    fs.writeFileSync(path.join(home, ".twing", "auto-managed"), "x\n");
  }
  if (opts.lib ?? true) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "");
  }
  return { home, target };
}

function globalEntry(): string {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "twing-delegate-global-"));
  const entry = path.join(prefix, "lib", "node_modules", "@twing", "cli", "dist", "index.js");
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, "");
  return entry;
}

test("managedDelegateTarget: a global copy on a managed machine hands off", () => {
  const { home, target } = managedHome();
  assert.equal(managedDelegateTarget({ home, entry: globalEntry(), env: {} }), target);
});

test("managedDelegateTarget: runs locally before the managed copy exists or without the marker", () => {
  // Before the first lazy install there is nothing to hand off to; without
  // the marker the user deliberately runs an unmanaged install.
  const noLib = managedHome({ lib: false });
  assert.equal(managedDelegateTarget({ home: noLib.home, entry: globalEntry(), env: {} }), undefined);
  const noMarker = managedHome({ marker: false });
  assert.equal(managedDelegateTarget({ home: noMarker.home, entry: globalEntry(), env: {} }), undefined);
});

test("managedDelegateTarget: the managed copy itself never re-delegates", () => {
  const { home, target } = managedHome();
  assert.equal(managedDelegateTarget({ home, entry: target, env: {} }), undefined);
  assert.equal(managedDelegateTarget({ home, entry: globalEntry(), env: { TWING_MANAGED_DELEGATE: "1" } }), undefined);
});

test("managedDelegateTarget: npx and a twing-cli checkout run what was asked for", () => {
  const { home } = managedHome();
  const npx = path.join(os.tmpdir(), "npm-cache", "_npx", "abc", "node_modules", "@twing", "cli", "dist", "index.js");
  assert.equal(managedDelegateTarget({ home, entry: npx, env: {} }), undefined);

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "twing-delegate-repo-"));
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "twing-cli", private: true, workspaces: ["packages/*"] }));
  const checkout = path.join(repo, "packages", "cli", "dist", "index.js");
  fs.mkdirSync(path.dirname(checkout), { recursive: true });
  fs.writeFileSync(checkout, "");
  assert.equal(managedDelegateTarget({ home, entry: checkout, env: {} }), undefined);
});
