import { spawn } from "node:child_process";
import { serverEntryPath } from "./cli-paths.js";

export interface EphemeralServer {
  url: string;
  stop(): void;
}

/** Spawns a throwaway `twing serve` for this run only -- no persistence, no
 * reuse across runs, torn down when the simulator exits. */
export async function startEphemeralServer(port: number): Promise<EphemeralServer> {
  const child = spawn(process.execPath, [serverEntryPath()], {
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("twing serve did not report ready within 5s")), 5000);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[twing serve] ${chunk}`));
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`twing serve exited early (code ${code})`));
    });
  });

  return {
    url: `http://localhost:${port}`,
    stop: () => child.kill(),
  };
}
