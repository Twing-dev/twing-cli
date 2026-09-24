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
import { getCliVersion } from "./version.js";
import { MIN_NODE_MAJOR, MIN_NODE_MINOR, WIRED_HOOK_EVENTS } from "@twing/core";
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
function recordingNpm(opts: { installsHook?: boolean; writesHookStamp?: boolean; nodeVersion?: string; initFails?: boolean } = {}): { path: string; installs: () => number; initCwd: () => string; inits: () => number } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twing-resolve-npm-"));
  const record = path.join(dir, "record.txt");
  // A real `npm install` leaves the CLI behind, which is what gates the
  // script's `init` step -- so the fake one has to as well, or the step under
  // test never runs.
  const plantCli = 'mkdir -p "$HOME/.twing/lib/node_modules/@twing/cli/dist"\n: > "$HOME/.twing/lib/node_modules/@twing/cli/dist/index.js"\n';
  const plantHook = opts.installsHook
    ? `mkdir -p "$HOME/.twing/bin"\nprintf '#!/bin/sh\\ncat\\n' > "$HOME/.twing/bin/twing-hook"\nchmod +x "$HOME/.twing/bin/twing-hook"\n${opts.writesHookStamp ? `printf '${getCliVersion()}\\n' > "$HOME/.twing/bin/twing-hook.version"\n` : ""}`
    : "";
  fs.writeFileSync(path.join(dir, "npm"), `#!/bin/sh\necho "npm $*" >> ${JSON.stringify(record)}\n${plantCli}${plantHook}`, { mode: 0o755 });
  fs.writeFileSync(
    path.join(dir, "node"),
    `#!/bin/sh\necho "node $* [pwd=$(pwd -P)]" >> ${JSON.stringify(record)}\n`
      // `-v` answers for real: the script checks the version before installing,
      // and a stub silent here reads as "no usable node", skipping the install.
      + `case "$1" in -v|--version) echo "${opts.nodeVersion ?? "v22.5.0"}"; exit 0 ;; esac\n`
      + `case "$1" in -e) exec ${JSON.stringify(process.execPath)} "$@" ;; esac\n`
      + (opts.initFails ? "exit 1\n" : ""),
    { mode: 0o755 },
  );
  const lines = (): string[] => (fs.existsSync(record) ? fs.readFileSync(record, "utf8").split("\n") : []);
  return {
    path: `${dir}:${process.env.PATH ?? ""}`,
    installs: () => lines().filter((l) => l.startsWith("npm install")).length,
    initCwd: () => lines().find((l) => l.includes("init --unattended"))?.match(/\[pwd=(.*)\]$/)?.[1] ?? "",
    inits: () => lines().filter((l) => l.includes("init --unattended")).length,
  };
}

/** The shape Claude Code sends on a PreToolUse for an edit. */
function editPayload(filePath: string, sessionId = "s1"): string {
  return JSON.stringify({
    session_id: sessionId,
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
  // The stamp the CLI writes when it installs the binary. Without it the
  // resolver treats the binary as older than itself -- which is the point of
  // the stamp, and covered by its own tests below.
  fs.writeFileSync(path.join(bin, "twing-hook.version"), `${getCliVersion()}\n`);
  return home;
}

function markCoordinatorBootstrapped(home: string, server: string): void {
  const key = execFileSync("cksum", { input: server }).toString().split(/\s+/)[0];
  const dir = path.join(home, ".twing", "coordinator-bootstrap");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, key), `${server}\n`);
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
  // Derived from the constant rather than written as a literal: this
  // assertion was `/Node 20/` and went stale the moment the floor moved,
  // failing a test whose subject had not changed.
  assert.match(log, new RegExp(`Node ${MIN_NODE_MAJOR}\\.${MIN_NODE_MINOR}`), "and what it needs to be");
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

test("resolverScript: initializes a child coordinator once after SessionStart initialized its parent", async () => {
  const parent = twingRepo();
  const child = path.join(parent, "child");
  fs.mkdirSync(path.join(child, ".twing"), { recursive: true });
  fs.writeFileSync(path.join(child, ".twing", "twing.yml"), "coordinator:\n  serverUrl: http://127.0.0.1:2\n");
  const home = tmpdir();
  const npm = recordingNpm({ installsHook: true, writesHookStamp: true });

  run({ cwd: parent, home, event: "SessionStart", path: npm.path });
  run({ cwd: parent, home, event: "PreToolUse", path: npm.path, input: editPayload(path.join(child, "src", "a.ts")) });
  run({ cwd: parent, home, event: "PreToolUse", path: npm.path, input: editPayload(path.join(child, "src", "b.ts")) });

  assert.equal(npm.installs(), 1, "the managed CLI is installed once for both coordinators");
  assert.equal(npm.inits(), 2, "each coordinator runs unattended init once");
});

test("resolverScript: retries a coordinator whose unattended init failed", async () => {
  const repo = twingRepo();
  const npm = recordingNpm({ installsHook: true, writesHookStamp: true, initFails: true });
  const home = tmpdir();
  const payload = editPayload(path.join(repo, "src", "a.ts"));

  run({ cwd: repo, home, event: "PreToolUse", path: npm.path, input: payload });
  run({ cwd: repo, home, event: "PreToolUse", path: npm.path, input: payload });

  assert.equal(npm.installs(), 1, "a failed init does not redownload the existing CLI");
  assert.equal(npm.inits(), 2, "a failed init leaves no coordinator success stamp");
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

// --- an installed binary older than the CLI beside it -----------------------
//
// The failure these cover was found on a real machine: a 1.2.1 CLI, and a
// `twing-hook` from eight days earlier that has no case for Codex's
// `apply_patch`. Every Codex edit there was silently allowed. Claude Code
// repairs itself in that situation -- its edits reach the gate, which sees a
// version mismatch and recovers -- but the Codex path cannot, because the
// case it is missing *is* the gate path. So the resolver has to notice
// before the binary runs.

/** A home whose binary predates the CLI: the stamp names an older version. */
function homeWithStaleBinary(stdout: string): string {
  const home = homeWithBinary(stdout);
  fs.writeFileSync(path.join(home, ".twing", "bin", "twing-hook.version"), "0.0.1\n");
  return home;
}

test("resolverScript: a stale binary still runs, rather than leaving the event unhandled", async () => {
  // The upgrade is an attempt, never a precondition. Refusing to run last
  // week's binary would trade a narrow silent gap for a total one.
  const { stdout, status } = run({ cwd: tmpdir(), home: homeWithStaleBinary("VERDICT_FROM_STALE"), event: "PreToolUse" });

  assert.equal(status, 0);
  assert.equal(stdout, "VERDICT_FROM_STALE");
});

test("resolverScript: a stale binary is upgraded once per session, not once per edit", async () => {
  // Both halves matter. Never attempting on an edit leaves a session started
  // outside a repo stuck on a stale binary for its whole life (the test
  // below). Attempting on every edit pays the installer's network timeout
  // before each one, on a machine that may be offline. The session id bounds
  // it to a single attempt.
  const repo = twingRepo();
  const home = homeWithStaleBinary("VERDICT_FROM_STALE");
  const npm = recordingNpm();
  const payload = editPayload(path.join(repo, "a.ts"));

  run({ cwd: repo, home, event: "PreToolUse", path: npm.path, input: payload });
  assert.equal(npm.installs(), 1, "the first edit of a session may recover");

  const second = run({ cwd: repo, home, event: "PreToolUse", path: npm.path, input: payload });
  assert.equal(npm.installs(), 1, "the second does not pay for it again");
  assert.equal(second.stdout, "VERDICT_FROM_STALE", "and is gated by the binary that is actually there");
});

test("resolverScript: a stale binary recovers from an edit, in a session started outside any repo", async () => {
  // The case this whole check exists for, and the one an upgrade restricted
  // to SessionStart could never reach: `cd ~/work && codex`, then edit a file
  // in a repo below. Nothing identifies a repo until the edit names a file,
  // so if the edit path cannot attempt the upgrade, a pre-`apply_patch`
  // binary silently allows every edit of that session.
  const repo = twingRepo();
  const outside = tmpdir();
  const home = homeWithStaleBinary("VERDICT_FROM_STALE");
  const npm = recordingNpm();

  run({ cwd: outside, home, event: "PreToolUse", path: npm.path, input: editPayload(path.join(repo, "src", "a.ts")) });

  assert.equal(npm.initCwd(), fs.realpathSync(repo), "it found the repo from the edited file and installed for it");
});

test("resolverScript: every file a patch names is considered, not just the first", async () => {
  // A Codex patch can add a file somewhere unmanaged while updating a managed
  // repo in the same call. Stopping at the first target resolved no
  // coordinator, installed nothing, and let the whole patch through ungated.
  const repo = twingRepo();
  const scratch = tmpdir();
  const npm = recordingNpm();
  const patch = [
    "*** Begin Patch",
    `*** Add File: ${path.join(scratch, "notes.md")}`,
    "+jotting",
    `*** Update File: ${path.join(repo, "src", "a.ts")}`,
    "+x",
    "*** End Patch",
  ].join("\n");

  run({
    cwd: scratch,
    home: tmpdir(),
    event: "PreToolUse",
    path: npm.path,
    input: JSON.stringify({ session_id: "s1", hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: patch } }),
  });

  assert.equal(npm.initCwd(), fs.realpathSync(repo), "the managed repo in the patch wins over the unmanaged file it also touches");
});

test("resolverScript: a matching binary is handed the event with no install attempt at all", async () => {
  // The steady state, on every event, for every machine that is current:
  // two tests and an exec, no subprocess and no network.
  const repo = twingRepo();
  const home = homeWithBinary("VERDICT_FROM_HOOK");
  markCoordinatorBootstrapped(home, "http://127.0.0.1:1");
  const { stdout } = run({ cwd: repo, home, event: "SessionStart" });

  assert.equal(stdout, "VERDICT_FROM_HOOK");
});

test("resolverScript: finds the repo to install for from a Codex patch, not just file_path", async () => {
  // Codex names no `file_path` -- its targets live inside the apply_patch
  // envelope. Reading only `file_path` meant a Codex session started outside
  // a repo walked up from the wrong directory, installed nothing, and stayed
  // ungated for its whole life.
  const repo = twingRepo();
  const outside = tmpdir();
  const npm = recordingNpm();
  const patch = `*** Begin Patch\n*** Update File: ${path.join(repo, "src", "a.ts")}\n+x\n*** End Patch`;

  const { status } = run({
    cwd: outside,
    home: tmpdir(), // nothing installed, so the install branch has to run
    event: "PreToolUse",
    path: npm.path,
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: patch } }),
  });

  assert.equal(status, 0);
  assert.equal(npm.initCwd(), fs.realpathSync(repo), "installed for the repo the patch names, not the directory Codex was started in");
});

test("resolverScript: an edit outside any repo does not spend the session's recovery attempt", async () => {
  // The bound is one attempt per session, and an edit that names no managed
  // repo is not an attempt -- there was nothing to install for. Recording it
  // anyway meant a scratch-file edit consumed the session's only try, and the
  // next edit, the one actually inside a twing repo, fell through to the
  // stale binary. Caught in review; it is the original bug one line earlier.
  const repo = twingRepo();
  const scratch = tmpdir();
  const home = homeWithStaleBinary("VERDICT_FROM_STALE");
  const npm = recordingNpm();

  run({ cwd: scratch, home, event: "PreToolUse", path: npm.path, input: editPayload(path.join(scratch, "notes.md")) });
  assert.equal(npm.installs(), 0, "nothing to install for, so nothing was attempted");

  run({ cwd: scratch, home, event: "PreToolUse", path: npm.path, input: editPayload(path.join(repo, "src", "a.ts")) });
  assert.equal(npm.installs(), 1, "and the attempt is still available for the edit that names a repo");
});

test("resolverScript: two sessions each get one attempt, and neither gets a second", async () => {
  // A single marker holding the most recent session id let two sessions
  // editing in turn overwrite each other's record, so both retried on every
  // edit -- exactly the hammering the bound exists to prevent, on a machine
  // whose install keeps failing.
  const repo = twingRepo();
  const home = homeWithStaleBinary("VERDICT_FROM_STALE");
  const npm = recordingNpm();
  const edit = (session: string) =>
    run({ cwd: repo, home, event: "PreToolUse", path: npm.path, input: editPayload(path.join(repo, "a.ts"), session) });

  edit("session-a");
  edit("session-b");
  assert.equal(npm.installs(), 2, "each session may try once");

  edit("session-a");
  edit("session-b");
  assert.equal(npm.installs(), 2, "and neither tries again");
});
