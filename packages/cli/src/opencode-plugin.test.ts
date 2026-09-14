import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  OPENCODE_PLUGIN_MARKER,
  openCodePluginPath,
  wireOpenCodePlugin,
  unwireOpenCodePlugin,
} from "./opencode-plugin.js";

function withIsolatedHome<T>(fn: () => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "twing-opencode-plugin-test-"));
  const original = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env.HOME;
    else process.env.HOME = original;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("wireOpenCodePlugin installs an idempotent global loader", () => {
  withIsolatedHome(() => {
    assert.equal(wireOpenCodePlugin("/home/dev/.twing/bin/twing-hook"), true);
    const installed = fs.readFileSync(openCodePluginPath(), "utf8");
    assert.ok(installed.startsWith(OPENCODE_PLUGIN_MARKER));
    assert.match(installed, /opencode-adapter\.js/);
    assert.match(installed, /\/home\/dev\/\.twing\/bin\/twing-hook/);
    assert.equal(wireOpenCodePlugin("/home/dev/.twing/bin/twing-hook"), false);
  });
});

test("wireOpenCodePlugin upgrades its own loader but preserves a same-named user plugin", () => {
  withIsolatedHome(() => {
    const target = openCodePluginPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${OPENCODE_PLUGIN_MARKER}\nold\n`);
    assert.equal(wireOpenCodePlugin("/new/hook"), true);
    assert.match(fs.readFileSync(target, "utf8"), /\/new\/hook/);

    fs.writeFileSync(target, "export const MyPlugin = async () => ({});\n");
    assert.throws(() => wireOpenCodePlugin("/new/hook"), /refusing to overwrite/);
    assert.equal(fs.readFileSync(target, "utf8"), "export const MyPlugin = async () => ({});\n");
  });
});

test("unwireOpenCodePlugin removes only Twing's generated file", () => {
  withIsolatedHome(() => {
    wireOpenCodePlugin("/hook");
    assert.equal(unwireOpenCodePlugin(), true);
    assert.equal(fs.existsSync(openCodePluginPath()), false);
    assert.equal(unwireOpenCodePlugin(), false);

    const target = openCodePluginPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "// user owned\n");
    assert.equal(unwireOpenCodePlugin(), false);
    assert.equal(fs.readFileSync(target, "utf8"), "// user owned\n");
  });
});
