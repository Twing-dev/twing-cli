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
  if (value === "human" || value === "openrouter") return value;
  throw new Error(`--${flagName} must be "human" or "openrouter", got "${value}"`);
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
      "  --driver-a human|openrouter   default: openrouter",
      "  --driver-b human|openrouter   default: openrouter",
      "  --claude-model <model>        default: haiku",
      "  --openrouter-model <model>    default: openai/gpt-oss-20b:free",
      "  --openrouter-key-file <path>  default: <repo root>/openrouter_key.txt",
      "  --server-port <port>          default: 8790",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help === "true") {
    printUsage();
    return;
  }

  const repoRoot = path.join(SIMULATOR_ROOT, "..");
  const scenario = loadScenario(flags.scenario ?? "retry-duplicate");

  await run({
    scenario,
    mode: asMode(flags.mode ?? "worktree"),
    driverA: asDriverKind(flags["driver-a"] ?? "openrouter", "driver-a"),
    driverB: asDriverKind(flags["driver-b"] ?? "openrouter", "driver-b"),
    claudeModel: flags["claude-model"] ?? "haiku",
    openrouterModel: flags["openrouter-model"] ?? "openai/gpt-oss-20b:free",
    openrouterKeyFile: flags["openrouter-key-file"] ?? path.join(repoRoot, "openrouter_key.txt"),
    serverPort: Number(flags["server-port"] ?? 8790),
    workspacesRoot: path.join(SIMULATOR_ROOT, ".workspaces"),
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
