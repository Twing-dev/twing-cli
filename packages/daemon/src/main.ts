import * as os from "node:os";
import * as path from "node:path";
import { startDaemon } from "./server.js";

function defaultSocketPath(): string {
  return path.join(os.homedir(), ".twing", "daemon.sock");
}

const socketPath = process.env.TWING_SOCK ?? defaultSocketPath();

const daemon = await startDaemon(socketPath);
console.log(`twing daemon: listening on ${daemon.socketPath}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await daemon.close();
    process.exit(0);
  });
}
