import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { cliEntryPath } from "./cli-paths.js";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 16 * 1024 * 1024;

export async function runTwingInit(cwd: string, serverUrl: string): Promise<void> {
  await execFileAsync(process.execPath, [cliEntryPath(), "init", "--server", serverUrl], { cwd, maxBuffer: MAX_BUFFER });
}

/** Only for `--disable-design-gate` (2026-10-01: the gate is on by default
 * -- its first-edit deny is how each agent registers the design the
 * semantic comparator then compares; see orchestrator.ts). */
export async function runTwingDesignDisableGate(cwd: string): Promise<void> {
  await execFileAsync(process.execPath, [cliEntryPath(), "design", "disable-gate"], { cwd, maxBuffer: MAX_BUFFER });
}

/** Inherits stdio so the thread list prints directly. These are the threads
 * the semantic comparator opened between the two sessions' designs -- the
 * one conflict signal left since bare `twing align`'s claim-conflict report
 * was removed (2026-10-01). */
export function runTwingAlignThreads(cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const args = [cliEntryPath(), "align", "threads"];
    const child = spawn(process.execPath, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 0));
  });
}
