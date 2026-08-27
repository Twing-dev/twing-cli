import * as net from "node:net";
import * as fs from "node:fs";
import { dirname } from "node:path";
import {
  FrameDecoder,
  encodeFrame,
  findRepoRoot,
  computeProjectId,
  computeDeveloperId,
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

  // Socket-triggered equivalent of `close()`/the SIGINT handler
  // (runDaemonForeground) -- lets `twing daemon restart` ask a running
  // daemon to exit cleanly regardless of how it was started (foreground,
  // spawn-daemon.ts's detached child, or an installed OS service).
  const onShutdownRequested = async (): Promise<void> => {
    syncer.stop();
    server.close(() => {
      if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
      process.exit(0);
    });
  };

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
        handleMessage(raw, conn, claims, callEdges, syncer, developerBySession, onShutdownRequested);
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
  onShutdownRequested: () => Promise<void>,
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
        // extractClaim already had this repo's manifest loaded (per-repo
        // cache in claims.ts) to check constraints -- reusing its
        // `coordinator.serverUrl` here is free, and keeps the capture path
        // (this handler) untouched by multi-server support: the hook still
        // does zero interpretation, exactly as §4 intends. Absent when the
        // repo has no coordinator configured yet -- the claim still gets
        // captured locally, it just can't sync until one is.
        if (result.coordinatorServerUrl) {
          syncer.registerProjectServer(result.claim.projectId, result.coordinatorServerUrl);
        }
        syncer.enqueue(result.claim, result.newCallEdges);
        console.log(
          `twing daemon: ${result.claim.stage} claim on ${result.claim.symbolId}` +
            (result.claim.signatureChanged ? " (signature changed)" : "") +
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
    // Independent of the developerId gate above -- versionMismatch() is
    // daemon-wide, not per-developer, so it can surface even for a session
    // with no prior claims (see its doc comment for the one remaining gap).
    const versionMismatch = syncer.versionMismatch() ?? undefined;
    conn.write(encodeFrame({ type: "notices", items, versionMismatch }));
    return;
  }

  if (message.type === "shutdown") {
    conn.write(encodeFrame({ type: "shutdown_ack" }));
    conn.end();
    // Let the ack flush before tearing the daemon down.
    setTimeout(() => void onShutdownRequested(), 50);
    return;
  }

  if (message.type === "get_claims") {
    const req = raw as GetClaimsMessage;
    // §6: "the live claim set -- reflects everything touched this session."
    // Scoped by projectId AND developerId, not sessionId -- align wants the
    // requesting developer's whole recent activity in this repo (multiple
    // Claude Code sessions, files touched then reverted, etc.), not just
    // one session, but it must NOT include other developers' claims. One
    // daemon normally serves one developer, so this was long invisible, but
    // it's a real gap whenever a single daemon sees multiple developerIds
    // for the same project -- e.g. two git worktrees sharing one origin
    // remote (same projectId) on one machine (one daemon), each with its
    // own local `user.email`. Without this filter, both sides would see
    // each other's work labeled as their own "local checks" instead of
    // "cross-session findings", which is exactly backwards.
    const now = Date.now();
    let projectId: string | undefined;
    let developerId: string | undefined;
    try {
      const repoRoot = findRepoRoot(req.cwd);
      projectId = computeProjectId(repoRoot);
      developerId = computeDeveloperId(repoRoot);
    } catch {
      // cwd doesn't resolve to a usable repo -- fall through to empty
    }
    const scopedClaims =
      projectId && developerId ? claims.filter((c) => c.projectId === projectId && c.developerId === developerId && c.ts + c.ttlMs > now) : [];
    const scopedEdges = projectId ? callEdges.filter((e) => e.projectId === projectId) : [];
    conn.write(encodeFrame({ type: "claims", claims: scopedClaims, callEdges: scopedEdges }));
    return;
  }

  console.error("twing daemon: unknown message type", message.type);
}
