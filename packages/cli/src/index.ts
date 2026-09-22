#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { startDaemon } from "./daemon/server.js";
import { defaultSocketPath, authFetch, computeDeveloperId, readConfig } from "@twing/core";
import { runInit } from "./init.js";
import { runGhUser } from "./ghuser.js";
import { installTwingHintResolution } from "./twing-command.js";
import { delegateToManagedInstall } from "./managed-delegate.js";
import { runUninstall } from "./uninstall.js";
import { getCliVersion } from "./version.js";
import { runDaemonRestart } from "./daemon-restart.js";
import { runLogin } from "./login.js";
import { runJoinGithub } from "./join.js";
import { runAlign, runAlignRespond, runAlignThreads, runAlignClose } from "./align.js";
import { runKeygen } from "./keygen.js";
import { resolveServerUrl, requireAuth } from "./auth.js";
import {
  runAdminBootstrap,
  runAdminInvite,
  runAdminListInvites,
  runAdminRevokeInvite,
  runAdminRevokeDeveloper,
  runAdminListDevelopers,
} from "./admin.js";
import { runConstraintsList, runConstraintsRemove } from "./constraints.js";
import { isResolverWired } from "./resolve-hook.js";
import { globalSettingsPath } from "./wire-hooks.js";
import { hookBinaryPath } from "./install-hook.js";
import {
  runProjectInvite,
  runProjectListInvites,
  runProjectRevokeInvite,
  runProjectRemoveDeveloper,
  runProjectListDevelopers,
  runProjectEnableEnforcement,
  runProjectDisableEnforcement,
} from "./project.js";
import {
  runDesignRegister,
  runDesignResolve,
  runDesignClose,
  runDesignAmend,
  runDesignResume,
  runDesignList,
  runDesignReviews,
  runDesignEnableGate,
  runDesignDisableGate,
} from "./design.js";

/** Reads this package's own `package.json` version directly -- always exactly
 * one directory up from wherever this module itself is running (`dist/` in
 * the built/npm-installed form, `packages/cli/` for its `package.json`),
 * whether that's a global npm install or a contributor's own monorepo
 * checkout. Deliberately not `npm list -g @twing/cli`/similar shell-out:
 * that reports what's installed globally, not what binary is actually
 * executing right now (e.g. `node packages/cli/dist/index.js` against a
 * local build while some other version is npm-installed globally). */
function getVersion(): string {
  return getCliVersion();
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    }
  }
  return flags;
}

function printUsage(): void {
  console.error(
    [
      "Usage:",
      "  twing [-C <dir>] <command>                (act on the repo at <dir>, not the current one)",
      "  twing --version | -v",
      "  twing init [--server <url>] [--invite <code>] [--no-auth] [--no-github] [--enable-enforcement] [--unattended] [--no-trust-codex-hooks]",
      "  twing init --ghuser                       (once per machine: work from any directory)",
      "  twing uninstall [--dry-run] [--purge-server-data]",
      "  twing login [--server <url>] [--token <pat>]",
      "  twing keygen --invite <code> [--server <url>] [--label <email>]",
      "  twing whoami [--server <url>] [--show-token]",
      "  twing servers [--show-token]",
      "  twing join --github [--server <url>]",
      "  twing daemon",
      "  twing daemon restart",
      "  twing align",
      "  twing align threads [--status open]",
      "  twing align respond --finding <threadId> --message \"...\"",
      "  twing align close --finding <threadId>",
      "  twing admin bootstrap [--server <url>] --token <bootstrap-token> [--label <email>] [--org-name <name>]",
      "  twing admin invite --label <email> [--server <url>] [--role admin|member] [--org-id <id>]",
      "  twing admin list-invites [--server <url>] [--org-id <id>]",
      "  twing admin revoke-invite --code <invite-code> [--server <url>]",
      "  twing admin revoke-developer --developer-id <id> [--server <url>]",
      "  twing admin list-developers [--server <url>] [--org-id <id>]",
      "  twing project invite --label <email> [--project <id>] [--server <url>] [--role admin|member]",
      "  twing project list-invites [--project <id>] [--server <url>]",
      "  twing project revoke-invite --code <invite-code> [--server <url>]",
      "  twing project remove-developer --developer-id <id> [--project <id>] [--server <url>]",
      "  twing project list-developers [--project <id>] [--server <url>]",
      "  twing project enable-enforcement",
      "  twing project disable-enforcement",
      "  twing design register --session <id> --summary \"...\" --creates a,b --touches c,d --depends-on e,f [--group <groupId>]",
      "  twing design register --from <file.yml|->   (structured template: goal + changes[action/target/intent]; - reads stdin)",
      "  twing design amend --id <designId> --from <file.yml|->   (append change items to an existing design)",
      "  twing design resolve --id <designId> (--adopt <designId> | --justify \"...\")",
      "  twing design amend --id <designId> [--touches a,b] [--creates c,d] [--depends-on e,f] [--summary \"...\"] [--group <groupId>]",
      "  twing design amend --id <designId> --reassign-project   (run from the correct repo -- moves an open, unencumbered design there)",
      "  twing design resume --id <designId> [--session <id>] [--touches a,b] [--creates c,d] [--depends-on e,f]",
      "  twing design close --id <designId>",
      "  twing design list [--status open] [--mine]",
      "  twing design reviews [--decide <reviewId> --decision approve|reject]",
      "  twing design enable-gate",
      "  twing design disable-gate",
      "  twing constraints list [--project <id>] [--server <url>]",
      "  twing constraints remove --id <constraintId> [--server <url>]",
    ].join("\n"),
  );
}

async function runDesignCommand(rest: string[]): Promise<void> {
  const [sub, ...subArgs] = rest;
  const flags = parseFlags(subArgs);
  const cwd = commandCwd;

  // `--help` after a subcommand name (`design register --help`) used to
  // reach the real handler like any other unrecognized flag and, for
  // `register` specifically, silently register a real empty design against
  // the live coordinator instead of printing usage -- found live,
  // 2026-08-17. `design register` itself now also refuses an empty
  // --summary as defense in depth, but every subcommand dispatcher gets
  // this check so none of them can repeat the same mistake.
  if (flags.help === "true") {
    printUsage();
    return;
  }

  switch (sub) {
    case "register":
      await runDesignRegister({
        cwd,
        server: flags.server,
        session: flags.session,
        label: flags.label,
        summary: flags.summary,
        creates: flags.creates,
        touches: flags.touches,
        dependsOn: flags["depends-on"],
        group: flags.group,
        from: flags.from,
      });
      return;
    case "resolve":
      await runDesignResolve({ cwd, server: flags.server, id: flags.id, adopt: flags.adopt, justify: flags.justify });
      return;
    case "amend":
      await runDesignAmend({
        cwd,
        server: flags.server,
        id: flags.id,
        touches: flags.touches,
        creates: flags.creates,
        dependsOn: flags["depends-on"],
        summary: flags.summary,
        group: flags.group,
        reassignProject: flags["reassign-project"] === "true",
        from: flags.from,
      });
      return;
    case "resume":
      await runDesignResume({ cwd, server: flags.server, id: flags.id, session: flags.session, touches: flags.touches, creates: flags.creates, dependsOn: flags["depends-on"] });
      return;
    case "close":
      await runDesignClose({ cwd, server: flags.server, id: flags.id });
      return;
    case "list":
      await runDesignList({ cwd, server: flags.server, status: flags.status, mine: flags.mine === "true" });
      return;
    case "reviews":
      await runDesignReviews({ cwd, server: flags.server, decide: flags.decide, decision: flags.decision === "approve" || flags.decision === "reject" ? flags.decision : undefined });
      return;
    case "enable-gate":
      runDesignEnableGate({ cwd });
      return;
    case "disable-gate":
      runDesignDisableGate({ cwd });
      return;
    default:
      printUsage();
      process.exit(1);
  }
}

/** Bare `twing align` is unchanged; `threads`/`respond`/`close` are the
 * alignment-thread subcommands (statefulness redesign, 2026-08) -- same
 * dispatch shape as `runDesignCommand` below. */
async function runAlignCommand(rest: string[]): Promise<void> {
  const cwd = commandCwd;
  const [maybeSub, ...subArgs] = rest;

  // Same dispatcher-level fix as runDesignCommand -- see its comment.
  // `align`'s own handlers are read-only/advisory (no destructive side
  // effect from a malformed call the way `design register` had), but a
  // stray `--help` should still show usage, not silently run with
  // whatever fields happened to be undefined.
  if (maybeSub === "threads") {
    const flags = parseFlags(subArgs);
    if (flags.help === "true") return printUsage();
    await runAlignThreads({ cwd, status: flags.status });
    return;
  }
  if (maybeSub === "respond") {
    const flags = parseFlags(subArgs);
    if (flags.help === "true") return printUsage();
    await runAlignRespond({ cwd, finding: flags.finding, message: flags.message });
    return;
  }
  if (maybeSub === "close") {
    const flags = parseFlags(subArgs);
    if (flags.help === "true") return printUsage();
    await runAlignClose({ cwd, finding: flags.finding });
    return;
  }

  const flags = parseFlags(rest);
  if (flags.help === "true") return printUsage();
  await runAlign({ cwd });
}

async function runAdminCommand(rest: string[]): Promise<void> {
  const [sub, ...subArgs] = rest;
  const flags = parseFlags(subArgs);
  const cwd = commandCwd;

  // Same dispatcher-level fix as runDesignCommand -- see its comment.
  if (flags.help === "true") {
    printUsage();
    return;
  }

  switch (sub) {
    case "bootstrap":
      await runAdminBootstrap({ cwd, server: flags.server, token: flags.token, label: flags.label, orgName: flags["org-name"] });
      return;
    case "invite":
      await runAdminInvite({ cwd, server: flags.server, label: flags.label, role: flags.role === "admin" || flags.role === "member" ? flags.role : undefined, orgId: flags["org-id"] });
      return;
    case "list-invites":
      await runAdminListInvites({ cwd, server: flags.server, orgId: flags["org-id"] });
      return;
    case "revoke-invite":
      await runAdminRevokeInvite({ cwd, server: flags.server, code: flags.code });
      return;
    case "revoke-developer":
      await runAdminRevokeDeveloper({ cwd, server: flags.server, developerId: flags["developer-id"] });
      return;
    case "list-developers":
      await runAdminListDevelopers({ cwd, server: flags.server, orgId: flags["org-id"] });
      return;
    default:
      printUsage();
      process.exit(1);
  }
}

async function runConstraintsCommand(rest: string[]): Promise<void> {
  const [sub, ...subArgs] = rest;
  const flags = parseFlags(subArgs);
  const cwd = commandCwd;

  // Same dispatcher-level fix as runDesignCommand -- see its comment.
  if (flags.help === "true") {
    printUsage();
    return;
  }

  switch (sub) {
    case "list":
      await runConstraintsList({ cwd, server: flags.server, project: flags.project });
      return;
    case "remove":
      await runConstraintsRemove({ cwd, server: flags.server, id: flags.id });
      return;
    default:
      printUsage();
      process.exit(1);
  }
}

async function runProjectCommand(rest: string[]): Promise<void> {
  const [sub, ...subArgs] = rest;
  const flags = parseFlags(subArgs);
  const cwd = commandCwd;

  // Same dispatcher-level fix as runDesignCommand -- see its comment.
  if (flags.help === "true") {
    printUsage();
    return;
  }

  switch (sub) {
    case "invite":
      await runProjectInvite({ cwd, server: flags.server, project: flags.project, label: flags.label, role: flags.role === "admin" || flags.role === "member" ? flags.role : undefined });
      return;
    case "list-invites":
      await runProjectListInvites({ cwd, server: flags.server, project: flags.project });
      return;
    case "revoke-invite":
      await runProjectRevokeInvite({ cwd, server: flags.server, code: flags.code });
      return;
    case "remove-developer":
      await runProjectRemoveDeveloper({ cwd, server: flags.server, project: flags.project, developerId: flags["developer-id"] });
      return;
    case "list-developers":
      await runProjectListDevelopers({ cwd, server: flags.server, project: flags.project });
      return;
    case "enable-enforcement":
      runProjectEnableEnforcement({ cwd });
      return;
    case "disable-enforcement":
      runProjectDisableEnforcement({ cwd });
      return;
    default:
      printUsage();
      process.exit(1);
  }
}

async function runWhoami(options: { server?: string; cwd: string; showToken?: boolean }): Promise<void> {
  const serverUrl = resolveServerUrl(options.cwd, options.server);
  if (!serverUrl) throw new Error("twing whoami: no server URL given -- pass --server <url> or set TWING_SERVER.");
  const token = requireAuth(serverUrl, "twing whoami");
  const res = await authFetch(`${serverUrl}/v1/auth/whoami`, {}, token, computeDeveloperId(options.cwd));
  const body = await res.json().catch(() => ({}));
  // `token` is already sitting in ~/.twing/config.json in plaintext, so
  // this isn't a new exposure -- just opt-in (not printed by default) so
  // it doesn't land in scrollback/screen-recordings every time someone
  // runs whoami to check their identity, the common case.
  const output = options.showToken && token ? { ...body, token } : body;
  console.log(JSON.stringify(output, null, 2));
}

/** First 8 chars + "..." -- enough to tell entries apart (and to eyeball-
 * confirm you're looking at the token you think you are) without printing
 * the whole thing where `--show-token` isn't also passed. */
function redactToken(token: string): string {
  return `${token.slice(0, 8)}...`;
}

/** `whoami` (above) answers "who am I on *this* server" -- singular,
 * always the resolved one. This is the different, orthogonal question,
 * "what servers do I have cached credentials for at all" -- a plain
 * listing of ~/.twing/config.json, no network calls, no single server to
 * resolve. Tokens redacted by default for the same reason whoami's own
 * `--show-token` is opt-in: this is far more likely to end up pasted into
 * a screen-recording or CI log than deliberately read by the one person
 * who's supposed to see it. */
async function runServers(options: { showToken?: boolean }): Promise<void> {
  const config = readConfig();
  const entries = Object.entries(config.servers ?? {});
  if (entries.length === 0) {
    console.log("twing servers: no cached servers -- run `twing login`/`twing init` against one first.");
    return;
  }
  for (const [url, auth] of entries) {
    const status = auth.noAuth
      ? "no-auth (no token needed)"
      : auth.authToken
        ? options.showToken
          ? auth.authToken
          : redactToken(auth.authToken)
        : "(no cached token)";
    console.log(`${url}  ${status}`);
  }
}

async function runDaemonForeground(): Promise<void> {
  const daemon = await startDaemon(defaultSocketPath());
  console.log(`twing daemon: listening on ${daemon.socketPath}`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      await daemon.close();
      process.exit(0);
    });
  }
}

/**
 * The directory every repo-scoped command resolves its repo from: `-C <dir>`
 * when given, cwd otherwise.
 *
 * A module-level value rather than a parameter threaded through twenty call
 * sites, because it is genuinely process-wide: it answers "where is this
 * invocation standing", which is exactly what cwd answered before, and no
 * single `twing` process is ever standing in two places.
 */
let commandCwd = process.cwd();

/**
 * Pulls `-C <dir>` out of argv, leaving the rest for the normal parsers.
 *
 * Extracted before anything else reads argv: `parseFlags` only recognises
 * `--flags`, so a leftover `-C` and its value would sit in the positional
 * stream and be read as a subcommand.
 */
function takeRepoScopeFlag(argv: string[]): string[] {
  const remaining: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === "-C" || argv[i] === "--directory") && argv[i + 1] !== undefined) {
      const dir = path.resolve(argv[i + 1]);
      if (!fs.existsSync(dir)) throw new Error(`twing: -C ${argv[i + 1]}: no such directory`);
      commandCwd = dir;
      i++;
      continue;
    }
    remaining.push(argv[i]);
  }
  return remaining;
}

/** The one-step install, named wherever a machine turns out to need it. */
const INSTALL_COMMAND = "curl -fsSL https://raw.githubusercontent.com/Twing-dev/twing-cli/main/install.sh | sh";

/**
 * Says so when twing is installed but wired into nothing.
 *
 * npm 12 blocks package install scripts by default, so `npm install -g
 * @twing/cli` no longer runs the setup that writes this machine's hook
 * wiring -- and a blocked script is a warning in npm's output, not a
 * failure. The result is a machine where `twing` runs, nothing is wired, no
 * hook ever fires, nothing is ever installed lazily, and no edit is ever
 * gated. Nothing else in the system is in a position to notice: the whole
 * design is that hooks fire without anyone typing a command.
 *
 * Deliberately quiet whenever there is any sign of wiring. `isResolverWired`
 * covers the machine-wide route; an existing hook binary covers a machine
 * wired the older way (binary-path entries from a pre-resolver `twing init`)
 * or by a repo's committed bootstrap hook, both of which are fine and
 * neither of which this should second-guess.
 *
 * And quiet for `init`, which is the command that wires. It ran before the
 * wiring it describes, so a fresh machine's very first `init --ghuser`
 * opened with "not wired -- run this other installer", immediately followed
 * by the lines saying twing had just wired Claude, Codex and OpenCode. A
 * warning that contradicts the next two lines of its own output teaches the
 * reader to distrust all of it.
 */
function warnIfUnwired(command: string | undefined): void {
  if (command === "uninstall" || command === "init" || command === "--version" || command === "-v") return;
  try {
    if (isResolverWired(globalSettingsPath())) return;
    if (fs.existsSync(hookBinaryPath())) return;
    console.error(
      `twing: installed, but not wired into any coding agent on this machine -- no hook will fire and no edit will be checked.\n  ${INSTALL_COMMAND}`,
    );
  } catch {
    // Unreadable settings are not this function's problem to report.
  }
}

async function main(): Promise<void> {
  const [, , ...argv] = takeRepoScopeFlag(process.argv);
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);
  warnIfUnwired(command);

  // A bare `twing --help`/`-h` already printed usage via the "unknown
  // command" fallback below (command === "--help" matches no case), but
  // exited 1 like a real error -- an explicit help request should exit 0.
  if (command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  if (command === "--version" || command === "-v") {
    console.log(getVersion());
    return;
  }

  switch (command) {
    case "init":
      // Machine-scoped, where the rest of `init` is repo-scoped: it wires
      // twing into ~/.claude/settings.json so sessions started outside a repo
      // root are covered too. Short-circuits before runInit, which resolves a
      // coordinator immediately and has nothing to resolve here.
      if (flags.ghuser === "true") {
        await runGhUser();
        return;
      }
      await runInit({
        server: flags.server,
        invite: flags.invite,
        noAuth: flags["no-auth"] === "true",
        noGithub: flags["no-github"] === "true",
        enableEnforcement: flags["enable-enforcement"] === "true",
        unattended: flags.unattended === "true",
        // Codex refuses to run a hook whose hash it has not recorded, so
        // wiring stamps twing's own entries by default. This leaves them for
        // Codex's own review screen instead.
        trustCodexHooks: flags["no-trust-codex-hooks"] !== "true",
        cwd: commandCwd,
      });
      return;
    case "uninstall":
      await runUninstall({
        dryRun: flags["dry-run"] === "true",
        purgeServerData: flags["purge-server-data"] === "true",
      });
      return;
    case "login":
      await runLogin({ server: flags.server, token: flags.token, cwd: commandCwd });
      return;
    case "keygen": {
      if (!flags.invite) throw new Error("twing keygen: --invite <code> is required");
      const serverUrl = resolveServerUrl(commandCwd, flags.server);
      if (!serverUrl) throw new Error("twing keygen: no server URL given -- pass --server <url> or set TWING_SERVER.");
      await runKeygen({ cwd: commandCwd, serverUrl, invite: flags.invite, label: flags.label });
      return;
    }
    case "whoami":
      await runWhoami({ server: flags.server, cwd: commandCwd, showToken: flags["show-token"] === "true" });
      return;
    case "servers":
      await runServers({ showToken: flags["show-token"] === "true" });
      return;
    case "join":
      if (flags.github !== "true") throw new Error("twing join: --github is required (the only join mechanism this command supports so far)");
      await runJoinGithub({ server: flags.server, cwd: commandCwd });
      return;
    case "daemon":
      if (rest[0] === "restart") {
        await runDaemonRestart();
        return;
      }
      await runDaemonForeground();
      return;
    case "align":
      await runAlignCommand(rest);
      return;
    case "design":
      await runDesignCommand(rest);
      return;
    case "admin":
      await runAdminCommand(rest);
      return;
    case "project":
      await runProjectCommand(rest);
      return;
    case "constraints":
      await runConstraintsCommand(rest);
      return;
    default:
      printUsage();
      process.exit(1);
  }
}

// Before anything else runs: an unmanaged copy on an auto-managed machine
// re-executes the command in ~/.twing/lib and exits (managed-delegate.ts).
delegateToManagedInstall();

// Before anything prints: hints like "run `twing login`" assume a `twing`
// on PATH, which a bootstrap-onboarded machine does not have. Installed
// here so both console output and the thrown-error handler below inherit
// it -- see twing-command.ts for why it is a choke point and why only
// backticked spans are touched.
installTwingHintResolution();

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
