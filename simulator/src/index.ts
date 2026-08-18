#!/usr/bin/env node
import * as path from "node:path";
import { loadScenario, SIMULATOR_ROOT } from "./config.js";
import { run, type DriverKind } from "./orchestrator.js";
import type { WorkspaceMode } from "./workspace.js";

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

function asDriverKind(value: string, flagName: string): DriverKind {
  if (value === "human" || value === "bedrock") return value;
  throw new Error(`--${flagName} must be "human" or "bedrock", got "${value}"`);
}

function asMode(value: string): WorkspaceMode {
  if (value === "worktree" || value === "clones") return value;
  throw new Error(`--mode must be "worktree" or "clones", got "${value}"`);
}

function printUsage(): void {
  console.error(
    [
      "Usage: twing-simulator [options]",
      "",
      "  --scenario <name-or-path>     default: retry-duplicate",
      "  --mode worktree|clones        default: worktree",
      "  --driver-a human|bedrock      default: bedrock",
      "  --driver-b human|bedrock      default: bedrock",
      "  --claude-model <model>        default: haiku",
      "  --bedrock-model <model>       default: google.gemma-4-31b",
      "  --bedrock-region <region>     default: AWS_REGION/AWS_DEFAULT_REGION env",
      "  --server-port <port>          default: 8790",
      "  --enable-design-gate          leave the §17 PreToolUse gate wired (default: off)",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help === "true") {
    printUsage();
    return;
  }

  const scenario = loadScenario(flags.scenario ?? "retry-duplicate");

  await run({
    scenario,
    mode: asMode(flags.mode ?? "worktree"),
    driverA: asDriverKind(flags["driver-a"] ?? "bedrock", "driver-a"),
    driverB: asDriverKind(flags["driver-b"] ?? "bedrock", "driver-b"),
    claudeModel: flags["claude-model"] ?? "haiku",
    bedrockModel: flags["bedrock-model"] ?? "google.gemma-4-31b",
    bedrockRegion: flags["bedrock-region"],
    serverPort: Number(flags["server-port"] ?? 8790),
    workspacesRoot: path.join(SIMULATOR_ROOT, ".workspaces"),
    enableDesignGate: flags["enable-design-gate"] === "true",
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
