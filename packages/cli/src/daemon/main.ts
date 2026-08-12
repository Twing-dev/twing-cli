import { defaultSocketPath } from "@twing/core";
import { startDaemon } from "./server.js";

const daemon = await startDaemon(defaultSocketPath());
console.log(`twing daemon: listening on ${daemon.socketPath}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await daemon.close();
    process.exit(0);
  });
}
