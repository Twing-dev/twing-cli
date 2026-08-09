import * as net from "node:net";
import * as fs from "node:fs";
import { dirname } from "node:path";
import {
  FrameDecoder,
  encodeFrame,
  stageForTool,
  type EnqueueMessage,
  type GetNoticesMessage,
} from "@twing/core";

/**
 * In-memory claim log. Stage 1 has no Tree-sitter, no call graph, no server
 * sync — this just proves the capture pipe end to end (§15 step 1). Real
 * claim extraction lands in stage 2.
 */
export interface StoredClaim {
  sessionId: string;
  cwd: string;
  toolName: EnqueueMessage["toolName"];
  stage: "soft" | "firm";
  receivedAt: number;
}

export interface DaemonHandle {
  socketPath: string;
  claims: StoredClaim[];
  close(): Promise<void>;
}

/**
 * Removes a stale socket file left behind by a crashed daemon, without
 * clobbering a socket that's actually live (would break a running instance).
 */
async function clearStaleSocket(socketPath: string): Promise<void> {
  if (!fs.existsSync(socketPath)) return;

  const stillAlive = await new Promise<boolean>((resolve) => {
    const probe = net.createConnection(socketPath);
    probe.once("connect", () => {
      probe.end();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });

  if (stillAlive) {
    throw new Error(`twing daemon: ${socketPath} is already in use by a running daemon`);
  }
  fs.unlinkSync(socketPath);
}

export async function startDaemon(socketPath: string): Promise<DaemonHandle> {
  await clearStaleSocket(socketPath);
  fs.mkdirSync(dirname(socketPath), { recursive: true });

  const claims: StoredClaim[] = [];

  const server = net.createServer((conn) => {
    const decoder = new FrameDecoder();

    conn.on("data", (chunk) => {
      let messages: unknown[];
      try {
        messages = decoder.push(chunk);
      } catch (err) {
        console.error("twing daemon: frame decode error", err);
        conn.destroy();
        return;
      }

      for (const raw of messages) {
        handleMessage(raw, conn, claims);
      }
    });

    conn.on("error", () => {
      // A hook client that dies mid-write is expected (§4: fire-and-forget,
      // sub-50ms budget) — never let it take the daemon down.
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  return {
    socketPath,
    claims,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
          resolve();
        });
      }),
  };
}

function handleMessage(raw: unknown, conn: net.Socket, claims: StoredClaim[]): void {
  const message = raw as { type?: string };

  if (message.type === "enqueue") {
    const enqueue = raw as EnqueueMessage;
    const stage = stageForTool(enqueue.toolName);
    claims.push({
      sessionId: enqueue.sessionId,
      cwd: enqueue.cwd,
      toolName: enqueue.toolName,
      stage,
      receivedAt: Date.now(),
    });
    console.log(`twing daemon: enqueued ${stage} claim (${enqueue.toolName}) for session ${enqueue.sessionId}`);
    conn.write(encodeFrame({ type: "ack" }));
    return;
  }

  if (message.type === "get_notices") {
    const _req = raw as GetNoticesMessage;
    // No notice computation yet (needs the server round-trip, §7) — an
    // empty list is a correct, honest answer at this stage.
    conn.write(encodeFrame({ type: "notices", items: [] }));
    return;
  }

  console.error("twing daemon: unknown message type", message.type);
}
