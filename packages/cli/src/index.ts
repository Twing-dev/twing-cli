#!/usr/bin/env node
import { startDaemon } from "./daemon/server.js";
import { defaultSocketPath, authFetch, computeDeveloperId } from "@twing/core";
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
  runDesignAmend,
  runDesignResume,
  runDesignList,
  runDesignReviews,
  runDesignEnableGate,
  runDesignDisableGate,
} from "./design.js";

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
      "  twing init [--server <url>] [--invite <code>] [--no-auth] [--no-github]",
      "  twing login [--server <url>] [--token <pat>]",
      "  twing keygen --invite <code> [--server <url>] [--label <email>]",
      "  twing whoami [--server <url>]",
      "  twing join --github [--server <url>]",
      "  twing daemon",
      "  twing align [--intent \"...\"]",
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
      "  twing design register --session <id> --summary \"...\" --creates a,b --touches c,d --depends-on e,f",
      "  twing design resolve --id <designId> (--adopt <designId> | --justify \"...\")",
      "  twing design amend --id <designId> [--touches a,b] [--creates c,d] [--depends-on e,f]",
      "  twing design resume --id <designId> [--session <id>] [--touches a,b] [--creates c,d] [--depends-on e,f]",
      "  twing design list [--status open]",
      "  twing design reviews [--decide <reviewId> --decision approve|reject]",
      "  twing design enable-gate",
      "  twing design disable-gate",
    ].join("\n"),
  );
}

async function runDesignCommand(rest: string[]): Promise<void> {
  const [sub, ...subArgs] = rest;
  const flags = parseFlags(subArgs);
  const cwd = process.cwd();

  switch (sub) {
    case "register":
      await runDesignRegister({ cwd, session: flags.session, label: flags.label, summary: flags.summary, creates: flags.creates, touches: flags.touches, dependsOn: flags["depends-on"] });
      return;
    case "resolve":
      await runDesignResolve({ cwd, id: flags.id, adopt: flags.adopt, justify: flags.justify });
      return;
    case "amend":
      await runDesignAmend({ cwd, id: flags.id, touches: flags.touches, creates: flags.creates, dependsOn: flags["depends-on"] });
      return;
    case "resume":
      await runDesignResume({ cwd, id: flags.id, session: flags.session, touches: flags.touches, creates: flags.creates, dependsOn: flags["depends-on"] });
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

/** Bare `twing align [--intent "..."]` is unchanged; `threads`/`respond`/
 * `close` are the alignment-thread subcommands (statefulness redesign,
 * 2026-08) -- same dispatch shape as `runDesignCommand` below. A bare
 * `--intent` flag (no subcommand word) still falls through to `runAlign`,
 * same as before this existed. */
async function runAlignCommand(rest: string[]): Promise<void> {
  const cwd = process.cwd();
  const [maybeSub, ...subArgs] = rest;

  if (maybeSub === "threads") {
    const flags = parseFlags(subArgs);
    await runAlignThreads({ cwd, status: flags.status });
    return;
  }
  if (maybeSub === "respond") {
    const flags = parseFlags(subArgs);
    await runAlignRespond({ cwd, finding: flags.finding, message: flags.message });
    return;
  }
  if (maybeSub === "close") {
    const flags = parseFlags(subArgs);
    await runAlignClose({ cwd, finding: flags.finding });
    return;
  }

  const flags = parseFlags(rest);
  await runAlign({ intent: flags.intent, cwd });
}

async function runAdminCommand(rest: string[]): Promise<void> {
  const [sub, ...subArgs] = rest;
  const flags = parseFlags(subArgs);
  const cwd = process.cwd();

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

async function runProjectCommand(rest: string[]): Promise<void> {
  const [sub, ...subArgs] = rest;
  const flags = parseFlags(subArgs);
  const cwd = process.cwd();

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

async function runWhoami(options: { server?: string; cwd: string }): Promise<void> {
  const serverUrl = resolveServerUrl(options.cwd, options.server);
  if (!serverUrl) throw new Error("twing whoami: no server URL given -- pass --server <url> or set TWING_SERVER.");
  const token = requireAuth(serverUrl, "twing whoami");
  const res = await authFetch(`${serverUrl}/v1/auth/whoami`, {}, token, computeDeveloperId(options.cwd));
  const body = await res.json().catch(() => ({}));
  console.log(JSON.stringify(body, null, 2));
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
      await runWhoami({ server: flags.server, cwd: process.cwd() });
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
    default:
      printUsage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
