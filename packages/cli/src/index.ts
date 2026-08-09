#!/usr/bin/env node
import { startDaemon } from "@twing/daemon";
import { defaultSocketPath } from "@twing/core";
import { runInit } from "./init.js";
import { runReviewDesign } from "./review-design.js";

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
  console.error("Usage:\n  twing init --server <url>\n  twing daemon\n  twing review-design [--intent \"...\"]");
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
    case "review-design":
      await runReviewDesign({ intent: flags.intent, cwd: process.cwd() });
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
