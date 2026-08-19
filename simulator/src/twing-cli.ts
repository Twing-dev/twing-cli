import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { cliEntryPath } from "./cli-paths.js";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 16 * 1024 * 1024;

export async function runTwingInit(cwd: string, serverUrl: string): Promise<void> {
  await execFileAsync(process.execPath, [cliEntryPath(), "init", "--server", serverUrl], { cwd, maxBuffer: MAX_BUFFER });
}

/** `init` wires the §17 design gate by default now. Scenarios written
 * before that existed (e.g. retry-duplicate) don't instruct their agents to
 * register a design, so without this the Edit|Write fallback would deny
 * every edit in every scenario run unless `--enable-design-gate` is passed
 * explicitly -- see orchestrator.ts. */
export async function runTwingDesignDisableGate(cwd: string): Promise<void> {
  await execFileAsync(process.execPath, [cliEntryPath(), "design", "disable-gate"], { cwd, maxBuffer: MAX_BUFFER });
}

/** Inherits stdio so `align`'s own report prints directly -- that report
 * *is* the point of running the simulator, not something to re-format. */
export function runTwingAlign(cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const args = [cliEntryPath(), "align"];
    const child = spawn(process.execPath, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 0));
  });
}
