/**
 * `resolve-hook.ts` -- the machine-wide wiring that makes twing work from a
 * session started anywhere, not only at a repo root.
 *
 * The generated script is exercised under a real `sh`, not asserted as a
 * string: the branches it has to get right (stand down, exec, install, refuse
 * to install) are shell behaviour, and one of them is a machine-wide outage
 * if it regresses.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withHome } from "./test-support.js";
import { WIRED_HOOK_EVENTS } from "@twing/core";
import {
  RESOLVER_MARKER,
  resolverScript,
  resolverPath,
  isResolverHook,
  isResolverWired,
  writeResolverWiring,
  removeResolverWiring,
} from "./resolve-hook.js";

interface HookCommand {
  type: "command";
  command: string;
  args?: string[];
}
interface ClaudeSettings {
  hooks?: Record<string, { matcher?: string; hooks: HookCommand[] }[]>;
  [key: string]: unknown;
}

function readSettings(p: string): ClaudeSettings {
  return JSON.parse(fs.readFileSync(p, "utf8")) as ClaudeSettings;
}

function resolverHooks(p: string): { event: string; matcher?: string; hook: HookCommand }[] {
  const found: { event: string; matcher?: string; hook: HookCommand }[] = [];
  for (const [event, entries] of Object.entries(readSettings(p).hooks ?? {})) {
    for (const entry of entries) {
      for (const hook of entry.hooks) {
        if (isResolverHook(hook)) found.push({ event, matcher: entry.matcher, hook });
      }
    }
  }
  return found;
}

const expectedPairs = WIRED_HOOK_EVENTS.map(({ event, matcher }) => `${event}:${matcher ?? "-"}`).sort();

// --- wiring -----------------------------------------------------------------

test("writeResolverWiring: writes the script and wires exactly the events the committed hook covers", async () => {
  // The two wiring sources must stay identical in coverage: whichever one is
  // authoritative on a machine has to deliver the whole product, and a subset
  // is what left a developer with the gate but no daemon and no capture.
  await withHome(async (home) => {
    const settings = path.join(home, ".claude", "settings.json");
    assert.equal(writeResolverWiring(settings), true);

    assert.ok(fs.existsSync(resolverPath()), "the script must be written");
    assert.equal(fs.readFileSync(resolverPath(), "utf8"), resolverScript());
    assert.deepEqual(
      resolverHooks(settings).map(({ event, matcher }) => `${event}:${matcher ?? "-"}`).sort(),
      expectedPairs,
    );
  });
});

test("writeResolverWiring: every entry is a guarded pointer at an absolute path", async () => {
  await withHome(async (home) => {
    const settings = path.join(home, ".claude", "settings.json");
    writeResolverWiring(settings);

    for (const { event, hook } of resolverHooks(settings)) {
      assert.equal(hook.command, "sh");
      const args = hook.args ?? [];
      // The guard is what stops a deleted ~/.twing from blocking every edit.
      assert.match(args[0] ?? "", /^-c$/);
      assert.match(args[1] ?? "", /test -f .* \|\| exit 0/);
      // Absolute, not "$HOME/...": Claude Code passes these to sh verbatim,
      // with no shell in between to expand anything.
      assert.equal(args[args.length - 2], resolverPath());
      assert.ok(path.isAbsolute(args[args.length - 2] ?? ""));
      assert.equal(args[args.length - 1], event);
    }
  });
});

test("writeResolverWiring: calling it again changes nothing", async () => {
  await withHome(async (home) => {
    const settings = path.join(home, ".claude", "settings.json");
    writeResolverWiring(settings);
    const before = fs.readFileSync(settings, "utf8");
    assert.equal(writeResolverWiring(settings), false);
    assert.equal(fs.readFileSync(settings, "utf8"), before);
  });
});

test("writeResolverWiring: a changed event set replaces the old entries rather than accumulating", async () => {
  // The v2 -> v3 bootstrap rename appended beside instead of replacing, both
  // fired, and the stale one denied everything. Same hazard, same rule.
  await withHome(async (home) => {
    const settings = path.join(home, ".claude", "settings.json");
    writeResolverWiring(settings);
    // A stale entry for an event no longer wired.
    const s = readSettings(settings);
    s.hooks!["PreCompact"] = [{ hooks: [{ type: "command", command: "sh", args: ["-c", "x", "_", resolverPath(), "PreCompact"] }] }];
    fs.writeFileSync(settings, JSON.stringify(s, null, 2));

    assert.equal(writeResolverWiring(settings), true);
    assert.deepEqual(
      resolverHooks(settings).map(({ event, matcher }) => `${event}:${matcher ?? "-"}`).sort(),
      expectedPairs,
      "the stale entry must be gone, not sitting beside the current set",
    );
  });
});

test("writeResolverWiring: another tool's hooks survive", async () => {
  await withHome(async (home) => {
    const settings = path.join(home, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "some-other-tool" }] }] } }));

    writeResolverWiring(settings);
    const survivors = Object.values(readSettings(settings).hooks ?? {})
      .flatMap((entries) => entries.flatMap((e) => e.hooks))
      .filter((h) => !isResolverHook(h));
    assert.deepEqual(survivors.map((h) => h.command), ["some-other-tool"]);
  });
});

test("isResolverWired / removeResolverWiring: round trip", async () => {
  await withHome(async (home) => {
    const settings = path.join(home, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, "{}");
    assert.equal(isResolverWired(settings), false);

    writeResolverWiring(settings);
    assert.equal(isResolverWired(settings), true);

    assert.equal(removeResolverWiring(settings), true);
    assert.equal(isResolverWired(settings), false);
    assert.equal(fs.existsSync(resolverPath()), false, "uninstall must take the script too");
  });
});

// --- the script itself, under a real sh -------------------------------------

/** A PATH whose `npm`/`node` only record what they were asked to do. */
function recordingNpm(): { path: string; installs: () => number } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twing-resolve-npm-"));
  const record = path.join(dir, "record.txt");
  for (const tool of ["npm", "node"]) {
    fs.writeFileSync(path.join(dir, tool), `#!/bin/sh\necho "${tool} $*" >> ${JSON.stringify(record)}\n`, { mode: 0o755 });
  }
  return {
    path: `${dir}:${process.env.PATH ?? ""}`,
    installs: () => (fs.existsSync(record) ? fs.readFileSync(record, "utf8").split("\n").filter((l) => l.startsWith("npm install")).length : 0),
  };
}

function run(opts: { cwd: string; home: string; event: string; projectDir?: string; path?: string }): { stdout: string; status: number } {
  try {
    const stdout = execFileSync("sh", ["-c", resolverScript(), "twing-resolver", opts.event], {
      cwd: opts.cwd,
      env: { HOME: opts.home, CLAUDE_PROJECT_DIR: opts.projectDir ?? opts.cwd, PATH: opts.path ?? process.env.PATH ?? "" },
    });
    return { stdout: stdout.toString(), status: 0 };
  } catch (err) {
    const e = err as { stdout?: Buffer; status?: number };
    return { stdout: e.stdout?.toString() ?? "", status: e.status ?? 1 };
  }
}

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "twing-resolve-"));
}

/** A twing repo whose coordinator refuses instantly (port 1), so the install
 * branch runs without waiting on a network timeout. */
function twingRepo(): string {
  const repo = tmpdir();
  fs.mkdirSync(path.join(repo, ".twing"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".twing", "twing.yml"), "coordinator:\n  serverUrl: http://127.0.0.1:1\n");
  return repo;
}

function homeWithBinary(stdout: string): string {
  const home = tmpdir();
  const bin = path.join(home, ".twing", "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "twing-hook"), `#!/bin/sh\nprintf '%s' '${stdout}'\n`, { mode: 0o755 });
  return home;
}

test("resolverScript: stands down when the project dir commits its own twing hook", async () => {
  // Claude Code runs every matching hook in parallel across settings scopes,
  // so without this both would work and every edit would be gate-checked
  // twice.
  const proj = tmpdir();
  fs.mkdirSync(path.join(proj, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(proj, ".claude", "settings.json"),
    JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: "sh", args: ["${CLAUDE_PROJECT_DIR}/.twing/bootstrap-hook.sh", "PreToolUse"] }] }] } }),
  );
  const { stdout, status } = run({ cwd: proj, home: homeWithBinary("SHOULD_NOT_RUN"), event: "PreToolUse" });
  assert.equal(status, 0);
  assert.equal(stdout, "", "the committed hook owns this session");
});

test("resolverScript: stands down for an older inlined committed hook too", async () => {
  // A repo may still carry a v1-v3 committed hook; it covers this session
  // just as well, and double-firing would be just as wrong.
  const proj = tmpdir();
  fs.mkdirSync(path.join(proj, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(proj, ".claude", "settings.json"),
    JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: "# twing-bootstrap-hook-v3\n..." }] }] } }),
  );
  assert.equal(run({ cwd: proj, home: homeWithBinary("SHOULD_NOT_RUN"), event: "PreToolUse" }).stdout, "");
});

test("resolverScript: execs the binary once installed, with no subprocess or network", async () => {
  const { stdout } = run({ cwd: tmpdir(), home: homeWithBinary("VERDICT_FROM_HOOK"), event: "PreToolUse" });
  assert.equal(stdout, "VERDICT_FROM_HOOK");
});

test("resolverScript: UserPromptSubmit never installs, however much it might want to", async () => {
  // Claude Code lowers the hook timeout to 30s on this event and discards the
  // output of a hook that overruns, so an npm install here would silently do
  // nothing at all. Better to leave it to an event that can finish.
  const npm = recordingNpm();
  const { stdout, status } = run({ cwd: twingRepo(), home: tmpdir(), event: "UserPromptSubmit", path: npm.path });
  assert.equal(status, 0);
  assert.equal(stdout, "");
  assert.equal(npm.installs(), 0);
});

test("resolverScript: SessionStart in a twing repo installs exactly once", async () => {
  const npm = recordingNpm();
  const { status } = run({ cwd: twingRepo(), home: tmpdir(), event: "SessionStart", path: npm.path });
  assert.equal(status, 0);
  assert.equal(npm.installs(), 1);
});

test("resolverScript: finds the repo from a subdirectory, which is the case that was broken", async () => {
  const repo = twingRepo();
  const nested = path.join(repo, "packages", "api", "src");
  fs.mkdirSync(nested, { recursive: true });
  const npm = recordingNpm();
  run({ cwd: nested, home: tmpdir(), event: "SessionStart", path: npm.path });
  assert.equal(npm.installs(), 1, "starting Claude in a subdirectory must still find the repo");
});

test("resolverScript: installs nothing when no twing repo is above cwd", async () => {
  // Nothing to install *for*: the coordinator decides the version, so there
  // is no version to ask for yet.
  const npm = recordingNpm();
  const { stdout, status } = run({ cwd: tmpdir(), home: tmpdir(), event: "SessionStart", path: npm.path });
  assert.equal(status, 0);
  assert.equal(stdout, "");
  assert.equal(npm.installs(), 0);
});

test("the wired entry is a no-op when the script is missing, not a block", async () => {
  // `sh` exits 2 when it cannot open a script, and Claude Code treats exit 2
  // on PreToolUse as a *block* -- so without the guard, `rm -rf ~/.twing`
  // would stop every edit in every repo with a raw shell error naming no fix.
  await withHome(async (home) => {
    const settings = path.join(home, ".claude", "settings.json");
    writeResolverWiring(settings);
    fs.rmSync(resolverPath());

    const entry = resolverHooks(settings)[0];
    const argv = (entry.hook.args ?? []).slice();
    let status = 0;
    try {
      execFileSync("sh", argv, { env: { HOME: home, PATH: process.env.PATH ?? "" } });
    } catch (err) {
      status = (err as { status?: number }).status ?? 1;
    }
    assert.equal(status, 0, "a missing script must be silent, never exit 2");
  });
});

test("resolverScript: carries its marker, so a later version can find and replace it", () => {
  assert.ok(resolverScript().includes(RESOLVER_MARKER));
});
