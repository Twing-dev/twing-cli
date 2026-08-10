import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { cliEntryPath } from "./cli-paths.js";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 16 * 1024 * 1024;

export async function runTwingInit(cwd: string, serverUrl: string): Promise<void> {
  await execFileAsync(process.execPath, [cliEntryPath(), "init", "--server", serverUrl], { cwd, maxBuffer: MAX_BUFFER });
}

/** Inherits stdio so `align`'s own report prints directly -- that report
 * *is* the point of running the simulator, not something to re-format. */
export function runTwingAlign(cwd: string, intent?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const args = [cliEntryPath(), "align"];
    if (intent) args.push("--intent", intent);
    const child = spawn(process.execPath, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 0));
  });
}
