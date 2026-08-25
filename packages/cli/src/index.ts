#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { startDaemon } from "./daemon/server.js";
import { defaultSocketPath, authFetch, computeDeveloperId, readConfig } from "@twing/core";
import { runInit } from "./init.js";
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
import {
  runProjectInvite,
  runProjectListInvites,
  runProjectRevokeInvite,
  runProjectRemoveDeveloper,
  runProjectListDevelopers,
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
  const packageJsonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { version?: string };
  return pkg.version ?? "unknown";
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
      "  twing --version | -v",
      "  twing init [--server <url>] [--invite <code>] [--no-auth] [--no-github]",
      "  twing login [--server <url>] [--token <pat>]",
      "  twing keygen --invite <code> [--server <url>] [--label <email>]",
      "  twing whoami [--server <url>] [--show-token]",
      "  twing servers [--show-token]",
      "  twing join --github [--server <url>]",
      "  twing daemon",
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
      "  twing design register --session <id> --summary \"...\" --creates a,b --touches c,d --depends-on e,f [--group <groupId>]",
      "  twing design resolve --id <designId> (--adopt <designId> | --justify \"...\")",
      "  twing design amend --id <designId> [--touches a,b] [--creates c,d] [--depends-on e,f] [--summary \"...\"]",
      "  twing design resume --id <designId> [--session <id>] [--touches a,b] [--creates c,d] [--depends-on e,f]",
      "  twing design close --id <designId>",
      "  twing design list [--status open]",
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
  const cwd = process.cwd();

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
        session: flags.session,
        label: flags.label,
        summary: flags.summary,
        creates: flags.creates,
        touches: flags.touches,
        dependsOn: flags["depends-on"],
        group: flags.group,
      });
      return;
    case "resolve":
      await runDesignResolve({ cwd, id: flags.id, adopt: flags.adopt, justify: flags.justify });
      return;
    case "amend":
      await runDesignAmend({ cwd, id: flags.id, touches: flags.touches, creates: flags.creates, dependsOn: flags["depends-on"], summary: flags.summary });
      return;
    case "resume":
      await runDesignResume({ cwd, id: flags.id, session: flags.session, touches: flags.touches, creates: flags.creates, dependsOn: flags["depends-on"] });
      return;
    case "close":
      await runDesignClose({ cwd, id: flags.id });
      return;
    case "list":
      await runDesignList({ cwd, status: flags.status });
      return;
    case "reviews":
      await runDesignReviews({ cwd, decide: flags.decide, decision: flags.decision === "approve" || flags.decision === "reject" ? flags.decision : undefined });
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
  const cwd = process.cwd();
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
  const cwd = process.cwd();

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
  const cwd = process.cwd();

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
  const cwd = process.cwd();

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

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  const flags = parseFlags(rest);

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
      await runInit({ server: flags.server, invite: flags.invite, noAuth: flags["no-auth"] === "true", noGithub: flags["no-github"] === "true", cwd: process.cwd() });
      return;
    case "login":
      await runLogin({ server: flags.server, token: flags.token, cwd: process.cwd() });
      return;
    case "keygen": {
      if (!flags.invite) throw new Error("twing keygen: --invite <code> is required");
      const serverUrl = resolveServerUrl(process.cwd(), flags.server);
      if (!serverUrl) throw new Error("twing keygen: no server URL given -- pass --server <url> or set TWING_SERVER.");
      await runKeygen({ cwd: process.cwd(), serverUrl, invite: flags.invite, label: flags.label });
      return;
    }
    case "whoami":
      await runWhoami({ server: flags.server, cwd: process.cwd(), showToken: flags["show-token"] === "true" });
      return;
    case "servers":
      await runServers({ showToken: flags["show-token"] === "true" });
      return;
    case "join":
      if (flags.github !== "true") throw new Error("twing join: --github is required (the only join mechanism this command supports so far)");
      await runJoinGithub({ server: flags.server, cwd: process.cwd() });
      return;
    case "daemon":
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

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
