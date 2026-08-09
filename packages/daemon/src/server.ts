import * as net from "node:net";
import * as fs from "node:fs";
import { dirname } from "node:path";
import { FrameDecoder, encodeFrame, type EnqueueMessage, type GetNoticesMessage, type Claim, type CallEdge } from "@twing/core";
import { extractClaim } from "./claims.js";

export interface DaemonHandle {
  socketPath: string;
  claims: Claim[];
  callEdges: CallEdge[];
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

  const claims: Claim[] = [];
  const callEdges: CallEdge[] = [];

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
        handleMessage(raw, conn, claims, callEdges);
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
    callEdges,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
          resolve();
        });
      }),
  };
}

function handleMessage(raw: unknown, conn: net.Socket, claims: Claim[], callEdges: CallEdge[]): void {
  const message = raw as { type?: string };

  if (message.type === "enqueue") {
    const enqueue = raw as EnqueueMessage;
    // Ack immediately, extraction happens after (§5: "daemon accepts and
    // returns immediately, processing happens after") — never block the
    // socket accept loop on parsing.
    conn.write(encodeFrame({ type: "ack" }));

    extractClaim({
      sessionId: enqueue.sessionId,
      cwd: enqueue.cwd,
      toolName: enqueue.toolName,
      toolInput: enqueue.toolInput,
    })
      .then((result) => {
        if (!result) return;
        claims.push(result.claim);
        callEdges.push(...result.newCallEdges);
        console.log(
          `twing daemon: ${result.claim.stage} claim on ${result.claim.symbolId}` +
            (result.claim.signatureChanged ? " (signature changed)" : "") +
            (result.claim.triggerMatches?.length ? ` [triggers: ${result.claim.triggerMatches.join(", ")}]` : "") +
            (result.claim.constraintIds?.length ? ` [constraints: ${result.claim.constraintIds.join(", ")}]` : "") +
            (result.newCallEdges.length ? ` [+${result.newCallEdges.length} call edges]` : ""),
        );
      })
      .catch((err) => {
        console.error("twing daemon: claim extraction failed", err);
      });
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
