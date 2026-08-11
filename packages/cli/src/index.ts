#!/usr/bin/env node
import { startDaemon } from "@twing/daemon";
import { defaultSocketPath } from "@twing/core";
import { runInit } from "./init.js";
import { runAlign } from "./align.js";
import {
  runDesignRegister,
  runDesignResolve,
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
      "  twing init --server <url>",
      "  twing daemon",
      "  twing align [--intent \"...\"]",
      "  twing design register --session <id> --summary \"...\" --creates a,b --touches c,d --depends-on e,f",
      "  twing design resolve --id <designId> (--adopt <designId> | --justify \"...\")",
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
      await runDesignResolve({ id: flags.id, adopt: flags.adopt, justify: flags.justify });
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
      await runInit({ server: flags.server, cwd: process.cwd() });
      return;
    case "daemon":
      await runDaemonForeground();
      return;
    case "align":
      await runAlign({ intent: flags.intent, cwd: process.cwd() });
      return;
    case "design":
      await runDesignCommand(rest);
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
