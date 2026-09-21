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
 * Wiring only happens where Codex actually is: `$CODEX_HOME`, else
 * `~/.codex`. A machine with neither is left alone entirely rather than
 * having a config file invented for a tool it does not run.
 */

import { spawn } from "node:child_process";
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
  /** False when this machine has no Codex: nothing was written. */
  present: boolean;
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
  /** Wire even where no Codex was found -- the tests' escape hatch, and the
   * one a future `twing init --codex` would use. */
  force?: boolean;
}

/** True when this machine looks like it runs Codex: it has a Codex home. */
export function codexPresent(configPath: string = codexConfigPath()): boolean {
  return fs.existsSync(path.dirname(configPath));
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

  if (!options.force && !codexPresent(configPath)) {
    return { present: false, changed: false, configPath, overrodeFeatureFlag: false };
  }

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

  return { present: true, changed, configPath, overrodeFeatureFlag: features.overrode };
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
  currentHash: string;
  trustStatus: string;
  isManaged?: boolean;
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
      ...(report.codexHome && report.codexHome !== path.dirname(configPath) ? { otherCodexHome: report.codexHome } : {}),
    };
  }

  const block = renderCodexTrustBlock(ours);
  const before = readConfig(configPath);
  const after = appendBlock(withoutBlock(before, CODEX_TRUST_START, CODEX_TRUST_END), block);
  if (after !== before) writeAtomically(configPath, after);

  return {
    outcome: "trusted",
    stamped: ours.length,
    ...(report.codexHome && report.codexHome !== path.dirname(configPath) ? { otherCodexHome: report.codexHome } : {}),
  };
}

/** Whether one reported hook is an entry twing wrote. Both halves matter:
 * the file it came from, and the command it runs. */
function isTwingHook(hook: CodexHookEntry, configPath: string): boolean {
  if (hook.sourcePath !== configPath) return false;
  const commands = new Set(codexHookEvents().map(({ event }) => codexHookCommand(event)));
  return typeof hook.command === "string" && commands.has(hook.command);
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

  const result = await trustCodexHooks({ configPath, bin: options.bin, query: options.query });
  if (result.outcome === "trusted") {
    log(
      `twing: recorded Codex's trust hash for twing's own ${result.stamped} hook entries in ${configPath}. ` +
        "No other hook in that file was trusted. Delete the twing-codex-trust block to have Codex ask you instead.",
    );
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

export function renderCodexTrustBlock(hooks: CodexHookEntry[]): string {
  const lines = [
    CODEX_TRUST_START,
    "# Codex runs a hook only once its hash is recorded here. These are",
    "# twing's own entries, recorded by `twing init` -- no other hook in this",
    "# file is trusted by twing. Re-run `twing init` after changing them, or",
    "# delete this block to have Codex ask you about them again.",
  ];
  for (const hook of hooks) {
    lines.push("", `[hooks.state.${JSON.stringify(hook.key)}]`, "enabled = true", `trusted_hash = ${JSON.stringify(hook.currentHash)}`);
  }
  lines.push("", CODEX_TRUST_END, "");
  return lines.join("\n");
}
