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

/**
 * A PATH whose `npm`/`node` only record what they were asked to do.
 *
 * `node -e` is the exception and runs for real: the script parses the hook
 * payload with it (see `start_dir`), which is a different job from the
 * install steps being stubbed out here.
 *
 * `installsHook` makes the fake `npm install` leave a hook binary behind, the
 * way a real install would, so tests can follow what happens *after* the
 * install -- including whether the payload still reaches the binary.
 */
function recordingNpm(opts: { installsHook?: boolean; nodeVersion?: string } = {}): { path: string; installs: () => number; initCwd: () => string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twing-resolve-npm-"));
  const record = path.join(dir, "record.txt");
  // A real `npm install` leaves the CLI behind, which is what gates the
  // script's `init` step -- so the fake one has to as well, or the step under
  // test never runs.
  const plantCli = 'mkdir -p "$HOME/.twing/lib/node_modules/@twing/cli/dist"\n: > "$HOME/.twing/lib/node_modules/@twing/cli/dist/index.js"\n';
  const plantHook = opts.installsHook
    ? 'mkdir -p "$HOME/.twing/bin"\nprintf \'#!/bin/sh\\ncat\\n\' > "$HOME/.twing/bin/twing-hook"\nchmod +x "$HOME/.twing/bin/twing-hook"\n'
    : "";
  fs.writeFileSync(path.join(dir, "npm"), `#!/bin/sh\necho "npm $*" >> ${JSON.stringify(record)}\n${plantCli}${plantHook}`, { mode: 0o755 });
  fs.writeFileSync(
    path.join(dir, "node"),
    `#!/bin/sh\necho "node $* [pwd=$(pwd -P)]" >> ${JSON.stringify(record)}\n`
      // `-v` answers for real: the script checks the version before installing,
      // and a stub silent here reads as "no usable node", skipping the install.
      + `case "$1" in -v|--version) echo "${opts.nodeVersion ?? "v22.0.0"}"; exit 0 ;; esac\n`
      + `case "$1" in -e) exec ${JSON.stringify(process.execPath)} "$@" ;; esac\n`,
    { mode: 0o755 },
  );
  const lines = (): string[] => (fs.existsSync(record) ? fs.readFileSync(record, "utf8").split("\n") : []);
  return {
    path: `${dir}:${process.env.PATH ?? ""}`,
    installs: () => lines().filter((l) => l.startsWith("npm install")).length,
    initCwd: () => lines().find((l) => l.includes("init --unattended"))?.match(/\[pwd=(.*)\]$/)?.[1] ?? "",
  };
}

/** The shape Claude Code sends on a PreToolUse for an edit. */
function editPayload(filePath: string): string {
  return JSON.stringify({
    session_id: "s1",
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_input: { file_path: filePath, old_string: "a", new_string: "b" },
  });
}

function run(opts: { cwd: string; home: string; event: string; projectDir?: string; path?: string; harness?: string; input?: string }): { stdout: string; status: number } {
  try {
    const stdout = execFileSync("sh", ["-c", resolverScript(), "twing-resolver", opts.event], {
      cwd: opts.cwd,
      input: opts.input ?? "",
      env: {
        HOME: opts.home,
        CLAUDE_PROJECT_DIR: opts.projectDir ?? opts.cwd,
        PATH: opts.path ?? process.env.PATH ?? "",
        ...(opts.harness ? { TWING_HARNESS: opts.harness } : {}),
      },
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

test("resolverScript: does not stand down under OpenCode, which never loads the committed Claude hook", async () => {
  const proj = tmpdir();
  fs.mkdirSync(path.join(proj, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(proj, ".claude", "settings.json"),
    JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: "sh", args: ["${CLAUDE_PROJECT_DIR}/.twing/bootstrap-hook.sh", "PreToolUse"] }] }] } }),
  );
  const { stdout } = run({ cwd: proj, home: homeWithBinary("VERDICT_FROM_HOOK"), event: "PreToolUse", harness: "opencode" });
  assert.equal(stdout, "VERDICT_FROM_HOOK");
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

test("resolverScript: a Node too old to run twing installs nothing, and says so", async () => {
  // npm only *warns* on an unsatisfiable engines field, so without this check
  // the install "succeeds" and dies later inside init, with an error pointing
  // into dist/ that names nothing the reader can act on.
  const home = tmpdir();
  const npm = recordingNpm({ nodeVersion: "v18.20.4" });
  const { status } = run({ cwd: twingRepo(), home, event: "SessionStart", path: npm.path });

  assert.equal(status, 0, "never block the session over it -- the gate's own deny is the backstop");
  assert.equal(npm.installs(), 0, "nothing downloaded, so the machine is left exactly as it was");

  const log = fs.readFileSync(path.join(home, ".twing", "bootstrap.log"), "utf8");
  assert.match(log, /v18\.20\.4/, "name the version actually found, not just the requirement");
  assert.match(log, /Node 20/, "and what it needs to be");
});

test("resolverScript: a too-old Node denies the edit rather than allowing it ungated", async () => {
  // The install paths here are asynchronous -- nobody is watching a terminal
  // -- so bootstrap.log is written where nobody reads. A PreToolUse deny is the one
  // channel that surfaces. Falling through to the silent `exit 0` the other
  // early returns use would leave the session ungated for its whole life.
  const npm = recordingNpm({ nodeVersion: "v18.20.4" });
  const { stdout, status } = run({ cwd: twingRepo(), home: tmpdir(), event: "PreToolUse", path: npm.path });

  assert.equal(status, 0, "a deny is carried in stdout, never by exiting non-zero");
  const verdict = JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
  assert.equal(verdict.hookSpecificOutput.permissionDecision, "deny");
  assert.match(verdict.hookSpecificOutput.permissionDecisionReason, /v18\.20\.4/, "name the version found");
  assert.match(verdict.hookSpecificOutput.permissionDecisionReason, /nothing on this machine was changed/);
  assert.equal(npm.installs(), 0);
});

test("resolverScript: finds the repo from a subdirectory, which is the case that was broken", async () => {
  const repo = twingRepo();
  const nested = path.join(repo, "packages", "api", "src");
  fs.mkdirSync(nested, { recursive: true });
  const npm = recordingNpm();
  run({ cwd: nested, home: tmpdir(), event: "SessionStart", path: npm.path });
  assert.equal(npm.installs(), 1, "starting Claude in a subdirectory must still find the repo");
});

// --- the parent-directory session, which cwd alone cannot see ---------------

test("resolverScript: a PreToolUse editing into a repo installs for it, from a cwd outside it", async () => {
  // `cd ~/work && claude`, then edit ~/work/repo/src/a.ts. Nothing above cwd
  // is a twing repo, so the cwd walk finds nothing and the whole session used
  // to run ungated.
  const parent = tmpdir();
  const repo = path.join(parent, "repo");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".twing"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".twing", "twing.yml"), "coordinator:\n  serverUrl: http://127.0.0.1:1\n");
  const npm = recordingNpm();

  run({ cwd: parent, home: tmpdir(), event: "PreToolUse", path: npm.path, input: editPayload(path.join(repo, "src", "a.ts")) });
  assert.equal(npm.installs(), 1, "the edited file identifies the repo even when cwd never enters it");
});

test("resolverScript: the install runs `init` from the repo, not from the session's directory", async () => {
  // `init` resolves the coordinator from its own cwd. Anchoring the *search*
  // on the edited file while leaving `init` in the session's directory
  // installed the CLI and then failed with "no coordinator configured" --
  // lib present, no hook binary, nothing gated. Seen live 2026-09-16.
  const parent = tmpdir();
  const repo = path.join(parent, "repo");
  fs.mkdirSync(path.join(repo, ".twing"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".twing", "twing.yml"), "coordinator:\n  serverUrl: http://127.0.0.1:1\n");
  const npm = recordingNpm();

  run({ cwd: parent, home: tmpdir(), event: "PreToolUse", path: npm.path, input: editPayload(path.join(repo, "src", "a.ts")) });
  assert.equal(npm.initCwd(), fs.realpathSync(repo), "init must run inside the repo it is installing for");
});

test("resolverScript: the payload still reaches the binary after the install consumed it", async () => {
  // stdin is spent by the time the hook binary runs, so the buffered copy has
  // to be handed over -- otherwise the gate gets an empty payload and the
  // edit that triggered the install is the one edit nobody checks.
  const parent = tmpdir();
  const repo = path.join(parent, "repo");
  fs.mkdirSync(path.join(repo, ".twing"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".twing", "twing.yml"), "coordinator:\n  serverUrl: http://127.0.0.1:1\n");
  const npm = recordingNpm({ installsHook: true });
  const payload = editPayload(path.join(repo, "src", "a.ts"));

  const { stdout } = run({ cwd: parent, home: tmpdir(), event: "PreToolUse", path: npm.path, input: payload });
  assert.equal(stdout, payload, "the freshly installed binary must read the payload this event carried");
});

test("resolverScript: a PreToolUse whose file is in no repo installs nothing", async () => {
  const npm = recordingNpm();
  const elsewhere = tmpdir();

  run({ cwd: tmpdir(), home: tmpdir(), event: "PreToolUse", path: npm.path, input: editPayload(path.join(elsewhere, "notes.md")) });
  assert.equal(npm.installs(), 0);
});

test("resolverScript: a PreToolUse carrying no file path still falls back to cwd", async () => {
  // ExitPlanMode and friends: no file_path in the payload, so the only anchor
  // left is where the session is.
  const npm = recordingNpm();
  const repo = twingRepo();

  run({ cwd: repo, home: tmpdir(), event: "PreToolUse", path: npm.path, input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "ExitPlanMode", tool_input: { plan: "do a thing" } }) });
  assert.equal(npm.installs(), 1);
});

test("resolverScript: a file path that only exists in the edit's *content* is not mistaken for the target", async () => {
  // Editing a file that itself contains `"file_path":` -- this script, for
  // one -- would fool a pattern match into installing for whatever repo the
  // content names.
  const npm = recordingNpm();
  const decoy = twingRepo();
  const payload = JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_input: {
      file_path: path.join(tmpdir(), "outside.ts"),
      new_string: `const sample = '{"file_path":"${path.join(decoy, "src", "a.ts")}"}';`,
    },
  });

  run({ cwd: tmpdir(), home: tmpdir(), event: "PreToolUse", path: npm.path, input: payload });
  assert.equal(npm.installs(), 0, "the real target is outside any repo; the decoy in the body must not count");
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
