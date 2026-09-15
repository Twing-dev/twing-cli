import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  OPENCODE_PLUGIN_MARKER,
  openCodeAdapterPath,
  openCodePluginPath,
  isOpenCodePluginWired,
  wireOpenCodePlugin,
  unwireOpenCodePlugin,
} from "./opencode-plugin.js";
import { withHome, captureConsole } from "./test-support.js";

test("wireOpenCodePlugin installs a loader and a stable adapter copy, idempotently", async () => {
  await withHome(async (home) => {
    assert.equal(wireOpenCodePlugin(), true);
    const loader = fs.readFileSync(openCodePluginPath(), "utf8");
    assert.ok(loader.startsWith(OPENCODE_PLUGIN_MARKER));
    assert.ok(loader.includes(JSON.stringify(path.join(home, ".twing", "opencode", "adapter.mjs"))));
    assert.ok(fs.existsSync(openCodeAdapterPath()), "the loader must not point into the copy that wrote it");
    assert.equal(wireOpenCodePlugin(), false);
  });
});

test("the generated loader loads the adapter, and does nothing once ~/.twing is gone", async () => {
  await withHome(async (home) => {
    wireOpenCodePlugin();
    // .mjs copy so Node loads it as ESM regardless of module detection.
    const copy = path.join(home, "loader.mjs");
    fs.copyFileSync(openCodePluginPath(), copy);
    const { Twing } = await import(pathToFileURL(copy).href) as { Twing: (ctx: object) => Promise<Record<string, unknown>> };

    const hooks = await Twing({ directory: home });
    assert.equal(typeof hooks["tool.execute.before"], "function");

    fs.rmSync(path.join(home, ".twing"), { recursive: true, force: true });
    assert.deepEqual(await Twing({ directory: home }), {}, "a missing adapter must not fail OpenCode's startup");
  });
});

test("wireOpenCodePlugin upgrades an older twing loader but leaves a same-named user plugin alone", async () => {
  await withHome(async () => {
    const target = openCodePluginPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "// twing-opencode-plugin-v1\nold\n");
    assert.equal(isOpenCodePluginWired(), true);
    assert.equal(wireOpenCodePlugin(), true);
    assert.ok(fs.readFileSync(target, "utf8").startsWith(OPENCODE_PLUGIN_MARKER));

    fs.writeFileSync(target, "export const MyPlugin = async () => ({});\n");
    const { result, warnings } = await captureConsole(async () => wireOpenCodePlugin());
    assert.equal(result, false, "someone else's plugin must not fail a Claude setup");
    assert.match(warnings.join("\n"), /isn't twing's/);
    assert.equal(fs.readFileSync(target, "utf8"), "export const MyPlugin = async () => ({});\n");
  });
});

test("unwireOpenCodePlugin removes only twing's files", async () => {
  await withHome(async () => {
    wireOpenCodePlugin();
    assert.equal(unwireOpenCodePlugin(), true);
    assert.equal(fs.existsSync(openCodePluginPath()), false);
    assert.equal(fs.existsSync(openCodeAdapterPath()), false);
    assert.equal(unwireOpenCodePlugin(), false);

    const target = openCodePluginPath();
    fs.writeFileSync(target, "// user owned\n");
    assert.equal(unwireOpenCodePlugin(), false);
    assert.equal(fs.readFileSync(target, "utf8"), "// user owned\n");
  });
});
