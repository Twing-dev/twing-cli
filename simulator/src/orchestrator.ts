import * as path from "node:path";
import { fixtureDir, type Scenario } from "./config.js";
import { setupWorkspace, type WorkspaceMode, type SessionWorkspace } from "./workspace.js";
import { startEphemeralServer } from "./ephemeral-server.js";
import { runTwingInit, runTwingAlign, runTwingDesignDisableGate } from "./twing-cli.js";
import { ClaudeSession } from "./claude-session.js";
import type { Driver } from "./drivers/driver.js";
import { HumanDriver, closeHumanInput } from "./drivers/human-driver.js";
import { BedrockDriver } from "./drivers/bedrock-driver.js";

export type DriverKind = "human" | "bedrock";

export interface RunOptions {
  scenario: Scenario;
  mode: WorkspaceMode;
  driverA: DriverKind;
  driverB: DriverKind;
  claudeModel: string;
  bedrockModel: string;
  bedrockRegion?: string;
  serverPort: number;
  workspacesRoot: string;
  /** §17: leaves the design gate wired (init's new default) instead of
   * disabling it right after init. Off by default -- existing scenarios
   * don't instruct their agents to register a design. */
  enableDesignGate: boolean;
}

// Longer than the daemon's ~7s claim-flush interval and ~5s notice-poll
// interval (§5) -- gives both sessions' background syncs a real chance to
// reach the server before we ask `align` to report on them.
const SETTLE_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createDriver(kind: DriverKind, options: RunOptions): Driver {
  if (kind === "human") return new HumanDriver();
  return new BedrockDriver(options.bedrockModel, options.bedrockRegion);
}

function truncate(text: string, max = 300): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/**
 * Errors here (a flaky driver call that exhausted its retries, claude -p
 * itself failing) are logged and swallowed rather than propagated -- this
 * runs under Promise.all alongside the other session, and one session
 * dying should not prevent the other from finishing or from getting its
 * `align` check at the end. Whatever real claims this session already
 * produced before failing are still worth reporting on.
 */
async function runSession(workspace: SessionWorkspace, goal: string, driver: Driver, model: string, maxTurns: number): Promise<void> {
  const label = workspace.label;
  try {
    await runSessionInner(workspace, goal, driver, model, maxTurns);
  } catch (err) {
    console.error(`[${label}] session failed: ${err instanceof Error ? err.message : err}`);
  }
}

async function runSessionInner(workspace: SessionWorkspace, goal: string, driver: Driver, model: string, maxTurns: number): Promise<void> {
  const label = workspace.label;
  const session = new ClaudeSession({ cwd: workspace.dir, model });

  console.log(`[${label}] goal: ${truncate(goal, 150)}`);
  let result = await session.send(goal);
  console.log(`[${label}] turn 1/${maxTurns} (cost $${result.costUsd.toFixed(4)}): ${truncate(result.resultText)}`);

  for (let turn = 1; turn < maxTurns; turn++) {
    const next = await driver.nextMessage({ sessionLabel: label, goal, turnNumber: turn, maxTurns, latestAgentResult: result.resultText });
    if (next === null) {
      console.log(`[${label}] driver ended the session after turn ${turn}.`);
      return;
    }
    console.log(`[${label}] -> ${truncate(next, 150)}`);
    result = await session.send(next);
    console.log(`[${label}] turn ${turn + 1}/${maxTurns} (cost $${result.costUsd.toFixed(4)}): ${truncate(result.resultText)}`);
  }
  console.log(`[${label}] reached max turns (${maxTurns}).`);
}

export async function run(options: RunOptions): Promise<void> {
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const workDir = path.join(options.workspacesRoot, runId);

  console.log(`twing-simulator: scenario "${options.scenario.name}" (${options.mode} mode)`);
  console.log(`twing-simulator: workspace ${workDir}`);
  const setup = setupWorkspace(options.mode, fixtureDir(options.scenario), workDir, runId);

  console.log(`twing-simulator: starting twing serve on port ${options.serverPort}...`);
  const server = await startEphemeralServer(options.serverPort);

  try {
    for (const session of setup.sessions) {
      console.log(`twing-simulator: twing init (session ${session.label}) in ${session.dir}`);
      await runTwingInit(session.dir, server.url);
      if (!options.enableDesignGate) {
        await runTwingDesignDisableGate(session.dir);
      } else {
        console.log(`twing-simulator: design gate (§17) left enabled for session ${session.label} -- edits are denied until a design is registered`);
      }
    }

    const driverA = createDriver(options.driverA, options);
    const driverB = createDriver(options.driverB, options);

    console.log("\ntwing-simulator: running both sessions concurrently...\n");
    await Promise.all([
      runSession(setup.sessions[0], options.scenario.sessions.a.goal, driverA, options.claudeModel, options.scenario.maxTurns),
      runSession(setup.sessions[1], options.scenario.sessions.b.goal, driverB, options.claudeModel, options.scenario.maxTurns),
    ]);

    console.log(`\ntwing-simulator: both sessions done -- waiting ${SETTLE_MS / 1000}s for background sync before checking align...`);
    await sleep(SETTLE_MS);

    for (const session of setup.sessions) {
      console.log(`\n=== twing align -- session ${session.label} (${session.dir}) ===`);
      await runTwingAlign(session.dir);
    }
  } finally {
    server.stop();
    closeHumanInput();
  }

  console.log(`\ntwing-simulator: done. Workspaces left on disk at ${workDir} for inspection.`);
}
