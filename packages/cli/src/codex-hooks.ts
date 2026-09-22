/**
 * Machine-global Codex wiring: twing's hook entries in Codex's own
 * `config.toml`.
 *
 * Codex (OpenAI's CLI, 0.114+) has a hook system deliberately shaped like
 * Claude Code's -- same event names, same `tool_name`/`tool_input` payload,
 * same `hookSpecificOutput.permissionDecision` reply -- so the binary those
 * entries point at is the same `twing-hook` Claude Code runs, and the only
 * translation needed lives in `hook/codex.go`. What differs is everything
 * *around* the hook, and that is what this file is:
 *
 *  - **The config is TOML, and it is the user's.** `~/.claude/settings.json`
 *    is JSON twing can parse, edit and re-emit; a `config.toml` carries
 *    comments and formatting no parser would give back. So twing's entries
 *    live in one marked block that is regenerated wholesale, and every byte
 *    outside it is left exactly as found -- the same "merge, never overwrite"
 *    rule `wire-hooks.ts` follows, enforced by text surgery instead of a
 *    parser.
 *
 *  - **Hooks are behind a feature flag.** `features.hooks` is still
 *    "under development" upstream, and with it off Codex reads the entries
 *    and runs nothing at all. Wiring therefore turns it on, because the
 *    alternative is a machine that looks wired and gates nothing.
 *
 *  - **Hooks are untrusted until their hash is recorded.** Codex will not run
 *    a hook it has not seen approved (normally through its startup review
 *    screen), which for `codex exec` in CI means never. `trustCodexHooks`
 *    records the hash for twing's own entries -- read back from Codex itself
 *    rather than recomputed here, so there is no hash format to keep mirrored
 *    -- and touches no other hook's trust. See its doc comment for why that
 *    is twing's call to make and where the opt-out is.
 *
 * Wiring happens whether or not Codex is installed yet, into `$CODEX_HOME`
 * (else `~/.codex`), creating the file if it is not there. Waiting for Codex
 * to exist sounds tidier and is worse: a developer who installs Codex a month
 * after `twing init --ghuser` would have no wiring and no way to learn it,
 * since nothing twing owns runs on that machine again unless they type a
 * command -- which is the one thing this project promises they never have to.
 * A config for a tool that never arrives costs one small file nobody reads.
 *
 * The half this cannot do ahead of time is trust: Codex records a hash for
 * each hook and runs none it has not seen, and there is no Codex to ask for
 * one yet. So a Codex installed later starts out wired-but-untrusted -- its
 * first interactive session asks the user to approve twing's entries, and any
 * later `twing init`/`--ghuser` records them without asking. `codex exec` in
 * automation shows no prompt, so on a machine that only ever runs Codex
 * non-interactively the entries stay inert until one of those happens. That
 * is stated in the wiring output rather than left to be discovered.
 */

import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Opens twing's block. Only ever appended to -- an unrecognised marker is a
 * block a new version would write *beside* instead of replacing, and two sets
 * of entries means two gate checks per edit. Same rule as
 * `KNOWN_RESOLVER_MARKERS`. */
export const CODEX_BLOCK_START = "# >>> twing-codex-hooks-v1 >>>";
export const CODEX_BLOCK_END = "# <<< twing-codex-hooks-v1 <<<";
export const KNOWN_CODEX_BLOCK_MARKERS = [{ start: CODEX_BLOCK_START, end: CODEX_BLOCK_END }];

/** Trust lives in its own block so re-wiring (which regenerates the entries
 * block) cannot drop it, and stamping (which regenerates the trust block)
 * cannot disturb the entries. */
export const CODEX_TRUST_START = "# >>> twing-codex-trust-v1 >>>";
export const CODEX_TRUST_END = "# <<< twing-codex-trust-v1 <<<";

export const CODEX_HOOK_SCRIPT_MARKER = "# twing-codex-hook-v1";

/** Where Codex keeps its configuration. `CODEX_HOME` wins, exactly as it does
 * for Codex itself -- and note that some packagings set it for you: the snap
 * pins it to the snap's own data directory, which is why `trustCodexHooks`
 * reports the home Codex itself names when it differs from this one. */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  const declared = env.CODEX_HOME?.trim();
  if (declared) return declared;
  return path.join(os.homedir(), ".codex");
}

export function codexConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(codexHome(env), "config.toml");
}

/** The launcher Codex runs. Under `~/.twing/bin` beside `twing-resolve`, and
 * for the same reason: the settings entry stays a fixed pointer, so the logic
 * behind it can change with the package instead of needing every developer to
 * re-run a command. */
export function codexHookScriptPath(home: string = os.homedir()): string {
  return path.join(home, ".twing", "bin", "twing-codex-hook");
}

/**
 * The launcher script.
 *
 * Two jobs. It says *which harness this is* -- `TWING_HARNESS=codex`, which
 * is what turns the `transcript_path` Codex hands over into a `codex-rollout`
 * descriptor (`hook/codex.go`) and what stops `twing-resolve` standing down
 * for a repo's committed Claude hook, which covers nothing under Codex. And
 * it prefers the resolver over the binary, so a machine that has never run
 * twing still installs it on the first gated edit, at the version that repo's
 * coordinator asks for.
 *
 * Both paths end in `exit 0` when nothing is installed: a hook that fails is
 * a hook Codex reports as an error on every tool call, and "twing isn't
 * installed here" is not an error.
 */
export function codexHookScript(): string {
  return `#!/bin/sh
${CODEX_HOOK_SCRIPT_MARKER}
#
# Written by \`twing init\`. Do not edit by hand -- it is regenerated
# wholesale, and ships with @twing/cli so it updates with the package.
#
# $1 is the Codex hook event this entry is wired for. stdin is the event
# payload, which is passed through untouched.

TWING_HARNESS=codex
export TWING_HARNESS

resolver="$HOME/.twing/bin/twing-resolve"
hook_bin="$HOME/.twing/bin/twing-hook"

# The resolver first: on a machine with no twing yet, it is what installs the
# version this repo's coordinator declares. It execs the binary afterwards.
if [ -x "$resolver" ]; then
  exec sh "$resolver" "$1"
fi

if [ -x "$hook_bin" ]; then
  exec "$hook_bin"
fi

# Nothing installed here. Not an error -- see this file's header.
exit 0
`;
}

interface CodexHookEvent {
  event: string;
  matcher?: string;
  timeout: number;
}

/**
 * Every event twing wires into Codex, mirroring `WIRED_HOOK_EVENTS`
 * (`@twing/core`) event for event, with two differences that are Codex's
 * rather than twing's:
 *
 *  - **No `ExitPlanMode`.** Codex's planning tool (`update_plan`) fires no
 *    hook at all -- confirmed against a real session -- so there is nothing
 *    to wire and no plan-time design registration under Codex. The `Edit`
 *    fallback (spec §9a) is what registers a design there: the first edit is
 *    denied with a filled-in `twing design register` template, which is the
 *    same path a Claude session that skips plan mode takes.
 *
 *  - **`apply_patch` in the tool matchers.** It is the tool Codex edits files
 *    with. `Edit|Write` stay listed beside it because Codex's tool set
 *    depends on the model's own metadata, and a build that offers a
 *    Claude-named edit tool must not slip past the gate.
 *
 * Timeouts are stated rather than left to Codex's defaults, which are not
 * uniform: `SessionEnd` defaulted to **one second** on 0.114, which is under
 * the budget its two jobs (draining capture, closing the session's design)
 * actually need. The generous ones are where an install can happen --
 * Claude Code's own budgets, for the same reason `resolve-hook.ts` cites.
 *
 * `SessionEnd` asks for exactly 3s because that is Codex's own ceiling for
 * that event: anything higher is clamped, and 0.155 reports the clamp as a
 * warning on every `hooks/list` ("clamping SessionEnd hook timeout to 3s").
 * Asking for what is actually available keeps that warning out of the
 * diagnostics an operator reads when something really is wrong, and costs
 * nothing -- the work on that path is a socket write and one HTTP call, and
 * it is a best-effort tidy-up in the first place (the TTL sweep is the
 * backstop, per §17.6).
 */
export function codexHookEvents(): CodexHookEvent[] {
  return [
    { event: "PreToolUse", matcher: "apply_patch|Edit|Write", timeout: 600 },
    { event: "PostToolUse", matcher: "apply_patch|Edit|Write|Read|Grep|Glob", timeout: 30 },
    { event: "SessionStart", timeout: 600 },
    { event: "UserPromptSubmit", timeout: 30 },
    { event: "SessionEnd", timeout: 3 },
  ];
}

/** The command string Codex runs for one event.
 *
 * `$HOME` rather than an absolute path: Codex runs this through a shell, so
 * the expansion happens there, and the same config then works for a home
 * directory that moves (a container image, a synced dotfile repo). The
 * existence test is load-bearing -- `rm -rf ~/.twing` must not turn every
 * Codex tool call into a hook error. */
export function codexHookCommand(event: string): string {
  const script = '"$HOME/.twing/bin/twing-codex-hook"';
  return `if [ -x ${script} ]; then exec ${script} ${event}; fi`;
}

/** twing's entries, as the TOML block that gets regenerated wholesale. */
export function renderCodexHookBlock(options: { includeFeatures: boolean }): string {
  const lines = [
    CODEX_BLOCK_START,
    "# Written by twing (https://github.com/Twing-dev/twing-cli).",
    "#",
    "# This block is regenerated wholesale -- edit above or below it, never",
    "# inside it. `twing uninstall` removes it and leaves the rest of this",
    "# file untouched. Each entry runs ~/.twing/bin/twing-codex-hook, which",
    "# exits silently when twing is not installed on this machine.",
  ];

  if (options.includeFeatures) {
    lines.push(
      "",
      "# Codex ignores every hook in this file unless this is on.",
      "[features]",
      "hooks = true",
    );
  }

  for (const { event, matcher, timeout } of codexHookEvents()) {
    lines.push("", `[[hooks.${event}]]`);
    if (matcher) lines.push(`matcher = ${JSON.stringify(matcher)}`);
    lines.push(
      "",
      `[[hooks.${event}.hooks]]`,
      'type = "command"',
      // A TOML literal string: the command contains double quotes and no
      // single ones, so nothing needs escaping and what is written is what
      // the shell sees.
      `command = '${codexHookCommand(event)}'`,
      `timeout = ${timeout}`,
    );
  }

  lines.push("", CODEX_BLOCK_END, "");
  return lines.join("\n");
}

/** Cuts a marked block (and the blank line before it) out of a config. */
function withoutBlock(config: string, start: string, end: string): string {
  const from = config.indexOf(start);
  if (from === -1) return config;
  const closing = config.indexOf(end, from);
  // A truncated block (someone deleted the end marker, an interrupted write)
  // is still ours: drop to end of file rather than leaving half a block that
  // the next wiring would append a second copy beside.
  const to = closing === -1 ? config.length : closing + end.length;
  const before = config.slice(0, from).replace(/\n+$/, "\n");
  const after = config.slice(to).replace(/^\n+/, "");
  return after.length > 0 ? `${before}\n${after}` : before;
}

/** The marked block as it stands, or "" -- the counterpart to
 * `withoutBlock`, and tolerant of the same truncated block. */
function extractBlock(config: string, start: string, end: string): string {
  const from = config.indexOf(start);
  if (from === -1) return "";
  const closing = config.indexOf(end, from);
  return closing === -1 ? config.slice(from) : config.slice(from, closing + end.length);
}

function withoutTwingBlocks(config: string): string {
  let result = config;
  for (const { start, end } of KNOWN_CODEX_BLOCK_MARKERS) result = withoutBlock(result, start, end);
  return withoutBlock(result, CODEX_TRUST_START, CODEX_TRUST_END);
}

/**
 * Whether the config already declares `features.hooks`, in either spelling
 * TOML allows (a `[features]` table, or a dotted top-level key).
 *
 * This is deliberately a scan and not a parse. The question is narrow enough
 * to answer with one -- and the cost of being wrong is bounded: a missed
 * declaration means twing's block writes a second `[features]` table, which
 * Codex rejects with a config error naming the file, rather than anything
 * silent.
 */
function featuresSection(config: string): { table: number; hooksLine: number } {
  const lines = config.split("\n");
  let table = -1;
  let hooksLine = -1;
  let inFeatures = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const header = /^\s*\[([^\]]+)\]\s*(#.*)?$/.exec(line);
    if (header) {
      inFeatures = header[1].trim() === "features";
      if (inFeatures && table === -1) table = i;
      continue;
    }
    if (/^\s*\[\[/.test(line)) {
      inFeatures = false;
      continue;
    }
    if (/^\s*features\s*\.\s*hooks\s*=/.test(line)) {
      hooksLine = i;
      continue;
    }
    if (inFeatures && /^\s*hooks\s*=/.test(line)) hooksLine = i;
  }
  return { table, hooksLine };
}

/**
 * Turns `features.hooks` on where the user already declares it, and reports
 * whether twing's own block still has to.
 *
 * An explicit `hooks = false` is rewritten to `true`. That is a real
 * override of something someone typed, and it is the honest one: leaving it
 * alone would mean `twing init` reporting Codex as wired while every hook in
 * the file is inert. `wireCodexHooks` says so in its result so the caller can
 * tell the user what changed under them.
 */
function applyFeaturesHooks(config: string): { config: string; needsOwnTable: boolean; overrode: boolean } {
  const { table, hooksLine } = featuresSection(config);
  if (hooksLine !== -1) {
    const lines = config.split("\n");
    const already = /=\s*true\s*(#.*)?$/.test(lines[hooksLine]);
    if (already) return { config, needsOwnTable: false, overrode: false };
    lines[hooksLine] = lines[hooksLine].replace(/=\s*[^#]*/, "= true ").replace(/\s+$/, "");
    return { config: lines.join("\n"), needsOwnTable: false, overrode: true };
  }
  if (table !== -1) {
    const lines = config.split("\n");
    lines.splice(table + 1, 0, "hooks = true  # added by twing: Codex runs no hooks at all without it");
    return { config: lines.join("\n"), needsOwnTable: false, overrode: false };
  }
  return { config, needsOwnTable: true, overrode: false };
}

/** Appends a block to a config, with exactly one blank line before it. */
function appendBlock(config: string, block: string): string {
  const base = config.replace(/\s*$/, "");
  return base.length === 0 ? block : `${base}\n\n${block}`;
}

export type CodexTrustOutcome =
  /** Trust recorded for twing's entries (or already correct). */
  | "trusted"
  /** Codex could not be asked -- not installed, too old, or it failed. */
  | "unavailable"
  /** The caller passed `trust: false`. */
  | "skipped";

export interface CodexWiring {
  /** Whether the Codex CLI is actually on this machine. The entries are
   * written either way; this says whether they can be trusted yet. */
  codexInstalled: boolean;
  /** True if the config or the launcher script changed. */
  changed: boolean;
  configPath: string;
  /** True when an explicit `features.hooks = false` was flipped to true. */
  overrodeFeatureFlag: boolean;
}

export interface CodexWiringOptions {
  /** Defaults to `codexConfigPath()`. */
  configPath?: string;
  /** Defaults to `codexHookScriptPath()`. */
  scriptPath?: string;
}

/**
 * Whether Codex itself is on this machine -- the question trust stamping and
 * the wiring message need, and the only thing the old "does `~/.codex` exist"
 * check was ever a proxy for. Now that twing creates that directory, it has
 * to ask properly.
 *
 * `command -v` rather than probing paths: it answers for a shim, an alias
 * target and a version manager's shim alike, which a directory scan does not.
 * One subprocess, at wiring time only, never on a hook event.
 */
export function codexInstalled(): boolean {
  try {
    const lookup = process.platform === "win32" ? ["where", "codex"] : ["sh", "-c", "command -v codex"];
    const found = execFileSync(lookup[0], lookup.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return found.trim().length > 0;
  } catch {
    return false;
  }
}

function writeAtomically(target: string, contents: string, mode?: number): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, contents, mode === undefined ? undefined : { mode });
    try {
      fs.renameSync(temporary, target);
    } catch {
      // Windows cannot rename over an existing file.
      fs.rmSync(target, { force: true });
      fs.renameSync(temporary, target);
    }
  } catch (err) {
    fs.rmSync(temporary, { force: true });
    throw err;
  }
}

function readConfig(configPath: string): string {
  try {
    return fs.readFileSync(configPath, "utf8");
  } catch {
    return "";
  }
}

/**
 * Writes (or refreshes) twing's hook entries in Codex's config and the
 * launcher they point at.
 *
 * Idempotent: an unchanged config is not rewritten, so re-running `twing
 * init` neither churns the file's mtime nor invalidates the trust hashes
 * recorded against it.
 */
export function wireCodexHooks(options: CodexWiringOptions = {}): CodexWiring {
  const configPath = options.configPath ?? codexConfigPath();
  const scriptPath = options.scriptPath ?? codexHookScriptPath();

  const script = codexHookScript();
  let changed = false;
  if (!fs.existsSync(scriptPath) || fs.readFileSync(scriptPath, "utf8") !== script) {
    writeAtomically(scriptPath, script, 0o755);
    changed = true;
  }

  const before = readConfig(configPath);
  // The user's file with every twing block lifted out, so the feature-flag
  // scan below never sees twing's own `[features]` table and mistake it for
  // the user's.
  const trust = extractBlock(before, CODEX_TRUST_START, CODEX_TRUST_END);
  const stripped = withoutTwingBlocks(before);
  const features = applyFeaturesHooks(stripped);

  let after = appendBlock(features.config, renderCodexHookBlock({ includeFeatures: features.needsOwnTable }));
  // Trust is keyed by the entries' position in this file, so it survives a
  // refresh that did not move them; `trustCodexHooks` rewrites it when they
  // did.
  if (trust) after = appendBlock(after, `${trust}\n`);

  if (after !== before) {
    writeAtomically(configPath, after);
    changed = true;
  }

  return { codexInstalled: codexInstalled(), changed, configPath, overrodeFeatureFlag: features.overrode };
}

/** True if twing's entries are in Codex's config. */
export function isCodexHooksWired(configPath: string = codexConfigPath()): boolean {
  const config = readConfig(configPath);
  return KNOWN_CODEX_BLOCK_MARKERS.some(({ start }) => config.includes(start));
}

/**
 * Removes twing's blocks and the launcher. Everything else in the config --
 * the user's own hooks, their model settings, their comments -- is left
 * exactly as it was.
 */
export function unwireCodexHooks(options: { configPath?: string; scriptPath?: string } = {}): boolean {
  const configPath = options.configPath ?? codexConfigPath();
  const scriptPath = options.scriptPath ?? codexHookScriptPath();

  let changed = false;
  if (fs.existsSync(scriptPath)) {
    fs.rmSync(scriptPath, { force: true });
    changed = true;
  }

  const before = readConfig(configPath);
  if (before) {
    const after = withoutTwingBlocks(before);
    // A file with nothing left in it is one twing created, for a Codex that
    // was never installed. Leaving an empty `config.toml` behind would be
    // leaving litter in a directory this machine has no other use for.
    if (after.trim() === "") {
      fs.rmSync(configPath, { force: true });
      try {
        fs.rmdirSync(path.dirname(configPath));
      } catch {
        /* the directory has other things in it, which is Codex's business */
      }
      return true;
    }
    if (after !== before) {
      // A `features.hooks` the *user* declared is deliberately left on: it is
      // Codex's own switch, it may be why their other hooks run, and turning
      // it off on the way out would break those. The one twing wrote lives
      // inside twing's block and goes with it.
      writeAtomically(configPath, after);
      changed = true;
    }
  }
  return changed;
}

/** One hook as Codex reports it. Only the fields twing needs to recognise
 * its own entries and record their hashes. */
export interface CodexHookEntry {
  key: string;
  command?: string;
  sourcePath: string;
  /** Typed as required because Codex always sends it -- but it arrives as
   * JSON from a process this code does not control, so every writer below
   * checks it rather than trusting the type. `trusted_hash = undefined` is
   * not valid TOML, and Codex answers an unparseable config by refusing to
   * load *any* of it: twing would have broken the user's Codex outright. */
  currentHash: string;
  trustStatus: string;
  isManaged?: boolean;
  /** Codex's own view of whether this hook is on. A *user* setting -- its UI
   * writes `hooks.state."<key>".enabled` when someone toggles a hook, and
   * that lands inside the block twing regenerates. See
   * `renderCodexTrustBlock`. */
  enabled?: boolean;
}

export interface CodexHooksReport {
  /** The Codex home Codex itself reports -- not always the one twing wrote
   * to (the snap pins `CODEX_HOME` to its own data directory). */
  codexHome?: string;
  hooks: CodexHookEntry[];
}

/**
 * Asks Codex about its own configuration, over the app-server protocol.
 *
 * Why ask rather than compute: the trust hash is Codex's, over a shape that
 * is still moving upstream, and a hash twing derived itself would be one more
 * mirrored format to keep in step -- with the failure mode being a hook that
 * reads as `modified` and silently never runs. Codex will tell us; the
 * handshake costs one short-lived process at wiring time, never per event.
 *
 * Resolves `undefined` for every failure, which are all the same answer:
 * Codex could not be asked, so trust is left for its own review screen.
 */
export async function queryCodexHooks(options: {
  configPath?: string;
  bin?: string;
  timeoutMs?: number;
} = {}): Promise<CodexHooksReport | undefined> {
  const configPath = options.configPath ?? codexConfigPath();
  const bin = options.bin ?? "codex";
  const timeoutMs = options.timeoutMs ?? 30_000;

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, ["app-server", "-c", "features.hooks=true"], {
        env: { ...process.env, CODEX_HOME: path.dirname(configPath) },
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      resolve(undefined);
      return;
    }

    const report: CodexHooksReport = { hooks: [] };
    let settled = false;
    let buffer = "";

    const finish = (value: CodexHooksReport | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);

    const send = (message: unknown): void => {
      try {
        child.stdin?.write(`${JSON.stringify(message)}\n`);
      } catch {
        finish(undefined);
      }
    };

    child.on("error", () => finish(undefined));
    // An app-server that exits before answering (an old Codex with no
    // `hooks/list`, a config it refuses to load) is an unavailable one.
    child.on("close", () => finish(undefined));
    child.stdin?.on("error", () => { /* reported by the close/error handlers */ });

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let message: { id?: number; result?: Record<string, unknown> };
        try {
          message = JSON.parse(line);
        } catch {
          continue; // notifications and anything else this exchange ignores
        }
        if (message.id === 1) {
          // The initialize reply carries the home Codex is actually using.
          const home = message.result?.codexHome;
          if (typeof home === "string") report.codexHome = home;
          // `hooks/list` is only answered after the handshake completes,
          // which is why this is a conversation and not one batched write.
          send({ method: "initialized", params: {} });
          send({ id: 2, method: "hooks/list", params: {} });
          continue;
        }
        if (message.id === 2) {
          const data = (message.result?.data ?? []) as { hooks?: CodexHookEntry[] }[];
          for (const entry of data) {
            for (const hook of entry.hooks ?? []) report.hooks.push(hook);
          }
          finish(report);
        }
      }
    });

    send({ id: 1, method: "initialize", params: { clientInfo: { name: "twing", title: "twing", version: "1" } } });
  });
}

export interface CodexTrustResult {
  outcome: CodexTrustOutcome;
  /** Set when Codex reports a different home than the one twing wired --
   * the snap does this, and nothing else twing writes would reveal it. */
  otherCodexHome?: string;
  /** How many of twing's entries were recorded. */
  stamped: number;
}

/**
 * Records Codex's trust hash for twing's own hook entries.
 *
 * Codex will not run an untrusted hook, and its review screen is a TUI --
 * so without this, wiring leaves a machine that looks set up and gates
 * nothing, and `codex exec` in automation would never prompt anyone at all.
 * Stamping is therefore the default, and the deliberate line it draws is
 * *whose* hooks: only entries whose `sourcePath` is the config twing just
 * wrote **and** whose command is the one twing generates. Someone else's
 * hook, a plugin's, a project's -- none of them become trusted because twing
 * ran. A later edit to twing's own entry breaks the hash and Codex marks it
 * `modified`, which is the check still doing its job.
 *
 * Opt out with `twing init --no-trust-codex-hooks`, which leaves the entries
 * for Codex's own review screen.
 */
export async function trustCodexHooks(options: {
  configPath?: string;
  bin?: string;
  query?: typeof queryCodexHooks;
} = {}): Promise<CodexTrustResult> {
  const configPath = options.configPath ?? codexConfigPath();
  const query = options.query ?? queryCodexHooks;

  const report = await query({ configPath, bin: options.bin });
  if (!report) return { outcome: "unavailable", stamped: 0 };

  const ours = report.hooks.filter((hook) => isTwingHook(hook, configPath));
  if (ours.length === 0) {
    // Codex answered but sees none of twing's entries: it read a different
    // config (the snap's, most likely) or an older Codex ignores them.
    return {
      outcome: "unavailable",
      stamped: 0,
      ...(differentHome(report.codexHome, configPath) ? { otherCodexHome: report.codexHome } : {}),
    };
  }

  const block = renderCodexTrustBlock(ours);
  const before = readConfig(configPath);
  const after = appendBlock(withoutBlock(before, CODEX_TRUST_START, CODEX_TRUST_END), block);
  if (after !== before) writeAtomically(configPath, after);

  return {
    outcome: "trusted",
    stamped: ours.length,
    ...(differentHome(report.codexHome, configPath) ? { otherCodexHome: report.codexHome } : {}),
  };
}

/**
 * Whether one reported hook is an entry twing wrote. Three things have to
 * hold: the file it came from, the command it runs, and a hash to record.
 *
 * The paths are compared symlink-resolved, because Codex resolves the one it
 * reports and twing does not: a `$HOME` or `$CODEX_HOME` reached through a
 * symlink -- an NFS-mounted home, a container bind, `/tmp` on macOS -- then
 * matches nothing, and trust is never stamped on a machine that looks
 * perfectly wired. Verified against a real `hooks/list` through a symlinked
 * CODEX_HOME, which reported the resolved path twing had never heard of.
 */
function isTwingHook(hook: CodexHookEntry, configPath: string): boolean {
  if (realPath(hook.sourcePath) !== realPath(configPath)) return false;
  if (!hasUsableHash(hook)) return false;
  const commands = new Set(codexHookEvents().map(({ event }) => codexHookCommand(event)));
  return typeof hook.command === "string" && commands.has(hook.command);
}

/** The path with symlinks resolved, or the path itself when it cannot be --
 * never a throw, since this only decides whether two names mean one file. */
function realPath(candidate: string): string {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return candidate;
  }
}

/** Whether Codex is reading a different home than the one twing wrote to --
 * symlink-resolved, so one spelling of the same directory is never reported
 * as a mismatch the user then goes chasing. */
function differentHome(reported: string | undefined, configPath: string): boolean {
  return reported !== undefined && realPath(reported) !== realPath(path.dirname(configPath));
}

/**
 * The trust step plus the one thing the user has to be told about it.
 *
 * Shared by `twing init` and the one-step install so both say the same
 * words. Every outcome is reported -- including "Codex could not be asked",
 * which is the one where twing is wired and Codex will still run nothing
 * until someone approves the entries.
 */
export async function reportCodexTrust(options: {
  configPath?: string;
  /** False for `--no-trust-codex-hooks`. */
  trust?: boolean;
  /** Whether Codex is on this machine. Injected by the tests; resolved with
   * `codexInstalled()` when absent. */
  codexInstalled?: boolean;
  log?: (message: string) => void;
  bin?: string;
  query?: typeof queryCodexHooks;
} = {}): Promise<CodexTrustResult> {
  const configPath = options.configPath ?? codexConfigPath();
  const log = options.log ?? ((message: string) => console.log(message));

  if (options.trust === false) {
    log(
      "twing: left Codex's hook trust alone (--no-trust-codex-hooks). Codex runs no hook it hasn't seen approved, " +
        "so twing stays inactive there until you approve its entries in Codex's startup review.",
    );
    return { outcome: "skipped", stamped: 0 };
  }

  // Nothing to ask. Say what that means rather than reporting a failure: the
  // entries are in place deliberately, ahead of a Codex that may arrive
  // later, and the message has to tell someone who has never installed Codex
  // something true rather than telling them to go and start it.
  if (options.codexInstalled === false || (options.codexInstalled === undefined && !codexInstalled())) {
    log(
      "twing: Codex isn't installed here yet -- its hooks are already in place, and its first session will ask " +
        "you to approve them once.",
    );
    return { outcome: "unavailable", stamped: 0 };
  }

  const result = await trustCodexHooks({ configPath, bin: options.bin, query: options.query });
  if (result.outcome === "trusted") {
    // Silent on success. The caller's own summary already says Codex is
    // wired, and what this used to print -- a hash count, a file path, which
    // other hooks were *not* trusted, how to undo it -- is mechanism, at the
    // one moment the reader has least use for it. Someone who wants it can
    // read the block; it says the same thing in the file it applies to.
  } else {
    log(
      `twing: wired twing into ${configPath}, but couldn't ask Codex to confirm its trust hashes. ` +
        "Codex runs no hook it hasn't seen approved -- start `codex` once and approve twing's entries in its review screen.",
    );
  }
  if (result.otherCodexHome) {
    log(
      `twing: note -- Codex reports its home as ${result.otherCodexHome}, not ${path.dirname(configPath)}. ` +
        `Some packagings (the snap, for one) pin CODEX_HOME. Re-run with CODEX_HOME=${result.otherCodexHome} to wire that one too.`,
    );
  }
  return result;
}

/**
 * The trust block, regenerated from what Codex currently reports.
 *
 * `enabled` is copied from Codex rather than asserted, and that is this
 * block's one subtlety: it is a *user* setting. Turning a hook off in Codex's
 * own UI writes `hooks.state."<key>".enabled = false`, and because that key
 * already exists here, Codex's TOML-aware writer edits it in place rather
 * than appending a second table. Writing `true` unconditionally would
 * therefore mean the next `twing init` quietly switched twing's hooks back on
 * for someone who had deliberately switched them off -- found by driving
 * Codex's own `config/batchWrite` against a wired config.
 *
 * (That the writer edits in place rather than appending is also what keeps
 * this safe at all: two `[hooks.state."<same key>"]` tables are a duplicate
 * key, and Codex then refuses to load the entire config file.)
 *
 * An entry with no usable hash is skipped rather than written: there is
 * nothing to record, and `trusted_hash = undefined` would be the config
 * error described on `currentHash` above.
 */
export function renderCodexTrustBlock(hooks: CodexHookEntry[]): string {
  const lines = [
    CODEX_TRUST_START,
    "# Codex runs a hook only once its hash is recorded here. These are",
    "# twing's own entries, recorded by `twing init` -- no other hook in this",
    "# file is trusted by twing. Re-run `twing init` after changing them, or",
    "# delete this block to have Codex ask you about them again.",
    "#",
    "# `enabled` is yours: turn one off in Codex and twing leaves it off.",
  ];
  for (const hook of hooks.filter(hasUsableHash)) {
    lines.push(
      "",
      `[hooks.state.${JSON.stringify(hook.key)}]`,
      `enabled = ${hook.enabled === false ? "false" : "true"}`,
      `trusted_hash = ${JSON.stringify(hook.currentHash)}`,
    );
  }
  lines.push("", CODEX_TRUST_END, "");
  return lines.join("\n");
}

/** Whether Codex reported a hash worth recording for this entry. */
function hasUsableHash(hook: CodexHookEntry): boolean {
  return typeof hook.currentHash === "string" && hook.currentHash.length > 0;
}
