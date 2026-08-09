import * as net from "node:net";
import * as fs from "node:fs";
import { dirname } from "node:path";
import {
  FrameDecoder,
  encodeFrame,
  findRepoRoot,
  computeProjectId,
  type EnqueueMessage,
  type GetNoticesMessage,
  type GetClaimsMessage,
  type Claim,
  type CallEdge,
} from "@twing/core";
import { extractClaim } from "./claims.js";
import { Syncer } from "./sync.js";

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
  const syncer = new Syncer();
  // A session only ever belongs to one developerId (§8), learned the first
  // time it produces a claim -- needed because get_notices only carries
  // sessionId (§4), not developerId.
  const developerBySession = new Map<string, string>();

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
        handleMessage(raw, conn, claims, callEdges, syncer, developerBySession);
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
        syncer.stop();
        server.close(() => {
          if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
          resolve();
        });
      }),
  };
}

function handleMessage(
  raw: unknown,
  conn: net.Socket,
  claims: Claim[],
  callEdges: CallEdge[],
  syncer: Syncer,
  developerBySession: Map<string, string>,
): void {
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
        developerBySession.set(result.claim.sessionId, result.claim.developerId);
        syncer.enqueue(result.claim, result.newCallEdges);
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
    const req = raw as GetNoticesMessage;
    const developerId = developerBySession.get(req.sessionId);
    // No claims from this session yet, so no developerId to look up
    // notices for -- an honest empty answer, not a lookup failure.
    const items = developerId ? syncer.noticesFor(developerId) : [];
    conn.write(encodeFrame({ type: "notices", items }));
    return;
  }

  if (message.type === "get_claims") {
    const req = raw as GetClaimsMessage;
    // §6: "the live claim set -- reflects everything touched this session,
    // including files since reverted." Scoped by projectId (every claim
    // this daemon has extracted already carries one) rather than by
    // sessionId, since `align` wants the whole repo's recent
    // activity, not just one Claude Code session.
    const now = Date.now();
    let projectId: string | undefined;
    try {
      projectId = computeProjectId(findRepoRoot(req.cwd));
    } catch {
      // cwd doesn't resolve to a usable repo -- fall through to empty
    }
    const scopedClaims = projectId ? claims.filter((c) => c.projectId === projectId && c.ts + c.ttlMs > now) : [];
    const scopedEdges = projectId ? callEdges.filter((e) => e.projectId === projectId) : [];
    conn.write(encodeFrame({ type: "claims", claims: scopedClaims, callEdges: scopedEdges }));
    return;
  }

  console.error("twing daemon: unknown message type", message.type);
}
