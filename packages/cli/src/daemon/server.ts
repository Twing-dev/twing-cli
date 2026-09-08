import * as net from "node:net";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import {
  FrameDecoder,
  encodeFrame,
  findRepoRoot,
  computeProjectId,
  computeDeveloperId,
  type EnqueueMessage,
  type GetNoticesMessage,
  type GetClaimsMessage,
  type SessionEndMessage,
  type Claim,
  type CallEdge,
} from "@twing/core";
import { extractClaim } from "./claims.js";
import { captureSession } from "./transcript.js";
import { Syncer, daemonVersion } from "./sync.js";

const STARTED_AT = Date.now();

export interface DaemonHandle {
  socketPath: string;
  claims: Claim[];
  callEdges: CallEdge[];
  close(): Promise<void>;
}

/** Set by `twing daemon restart`, and by nothing else -- the marker for
 * "a human explicitly asked for the running daemon to be replaced," which
 * is the only situation where taking the socket from a live holder is the
 * right move.
 *
 * Two other things start daemons on this machine (`spawn-daemon.ts`'s
 * detached child and the Go hook's self-heal), and neither sets this: if
 * more than one starter could evict, they can evict each other in a loop.
 * Keeping the capability on the one explicitly-invoked path means there is
 * never a second candidate to ping-pong against.
 *
 * This replaced `TWING_DAEMON_SUPERVISED`, which the launchd plist and
 * systemd unit used to set. That gate disappeared with the OS-level
 * service; the capability had to move somewhere that still exists, and an
 * explicit restart is a better home for it than a service manager that
 * never detected a wedged daemon in the first place (`Restart=on-failure`
 * and `KeepAlive` fire on *exit*, and a wedged daemon has not exited). */
const EVICTION_ENV = "TWING_DAEMON_EVICT";

/** How long the daemon sits with no client connection before exiting --
 * see `armIdleExit` in `startDaemon` for why it exits at all. Generous
 * relative to a session's own rhythm (the hook connects on every
 * UserPromptSubmit and every Edit/Write), so this only fires between
 * sessions, never inside one. `TWING_DAEMON_IDLE_MS` overrides it, mainly
 * so tests don't have to wait half an hour. */
const IDLE_EXIT_MS = Number(process.env.TWING_DAEMON_IDLE_MS ?? 30 * 60 * 1000);

/** Written beside the socket (so a `TWING_SOCK` override keeps its own
 * pidfile) at startup, removed on clean shutdown. Its job is to make a
 * future squatter identifiable even if it stops answering the socket at
 * all -- the identity message can't help once a process is wedged. */
export function daemonPidFilePath(socketPath: string): string {
  return join(dirname(socketPath), "daemon.pid");
}

function readPidFile(socketPath: string): number | undefined {
  try {
    const pid = Number.parseInt(fs.readFileSync(daemonPidFilePath(socketPath), "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function probeSocketAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createConnection(socketPath);
    probe.once("connect", () => {
      probe.end();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

/** Asks whoever holds the socket who they are. Null covers both "nothing
 * listening" and "something is listening but doesn't speak `get_identity`"
 * -- i.e. any daemon predating this release, which is exactly the case
 * eviction must refuse to guess about. */
function probeIdentity(socketPath: string, timeoutMs = 500): Promise<{ pid: number; version: string } | null> {
  return new Promise((resolve) => {
    const decoder = new FrameDecoder();
    let settled = false;
    const conn = net.createConnection(socketPath);
    const finish = (result: { pid: number; version: string } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    conn.once("connect", () => conn.write(encodeFrame({ type: "get_identity" })));
    conn.once("error", () => finish(null));
    conn.on("data", (chunk) => {
      let messages: unknown[];
      try {
        messages = decoder.push(chunk);
      } catch {
        finish(null);
        return;
      }
      for (const raw of messages) {
        const msg = raw as { type?: string; pid?: number; version?: string };
        if (msg.type === "identity" && typeof msg.pid === "number") {
          finish({ pid: msg.pid, version: String(msg.version ?? "unknown") });
        }
      }
    });
  });
}

/** Best-effort "who holds this socket" for the one case eviction refuses to
 * act on -- so the error can name a real PID for a human to kill instead of
 * saying only that something is in the way. */
function pidHoldingSocket(socketPath: string): number | undefined {
  try {
    const out = execFileSync("lsof", ["-t", socketPath], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const pid = Number.parseInt(out.trim().split(/\s+/)[0] ?? "", 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** At most one eviction per process start. After that, failing is the
 * correct outcome: exit non-zero rather than retry-looping against whatever
 * keeps taking the socket. */
let evictionAttempted = false;

/**
 * Removes a stale socket file left behind by a crashed daemon, without
 * clobbering a socket that's actually live (would break a running instance).
 *
 * When the socket *is* live, evicting the holder is only appropriate for a
 * daemon started by an explicit `twing daemon restart` -- the one case
 * where a human has actually asked for the running instance to be replaced.
 * That restriction is what stops two daemons evicting each other in a loop:
 * the auto-start paths (`spawn-daemon.ts`'s detached child and the Go
 * hook's self-heal) can *never* evict, so there is never more than one
 * candidate evictor in play. It also matches what eviction is for -- a
 * wedged daemon still answering the socket, which self-heal by definition
 * cannot detect, since to it a wedged daemon looks alive.
 *
 * Two further constraints keep the eviction from becoming a worse bug than
 * the one it fixes: only once per start, and never against a process that
 * can't be identified.
 */
async function clearStaleSocket(socketPath: string): Promise<void> {
  if (!fs.existsSync(socketPath)) return;

  if (!(await probeSocketAlive(socketPath))) {
    fs.unlinkSync(socketPath);
    return;
  }

  const identity = await probeIdentity(socketPath);
  const describe = identity ? `pid ${identity.pid}, version ${identity.version}` : "an unidentified process";

  if (process.env[EVICTION_ENV] !== "1" || evictionAttempted) {
    throw new Error(`twing daemon: ${socketPath} is already in use by a running daemon (${describe})`);
  }
  evictionAttempted = true;

  // The pidfile is the fallback for a daemon wedged badly enough to hold
  // the socket without answering on it. If neither names a pid, fail loudly
  // with whatever `lsof` can see: killing an unidentified process would
  // mean killing something that may not be a twing daemon at all.
  const pid = identity?.pid ?? readPidFile(socketPath);
  if (!pid || pid === process.pid) {
    const holder = pidHoldingSocket(socketPath);
    throw new Error(
      `twing daemon: ${socketPath} is held by ${describe} that predates identity support, so it cannot be safely evicted. ` +
        (holder ? `Kill it manually: kill -TERM ${holder}` : `Find it with \`lsof ${socketPath}\` and kill it manually.`),
    );
  }

  console.error(`twing daemon: evicting stale daemon (${describe}) holding ${socketPath}`);
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone between the probe and the signal -- the good case.
    }
    for (let i = 0; i < (signal === "SIGTERM" ? 12 : 8); i++) {
      if (!(await probeSocketAlive(socketPath))) {
        if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
        return;
      }
      await sleep(250);
    }
  }

  throw new Error(`twing daemon: ${socketPath} is still held by pid ${pid} after SIGTERM and SIGKILL -- refusing to retry`);
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
    clearTimeout(idleTimer);
    await syncer.stopAndFlush();
    server.close(() => {
      removePidFile(socketPath);
      if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
      process.exit(0);
    });
  };

  // Idle-exit. The daemon has no work between Claude Code sessions: claims
  // only arrive from hooks, notices are only consumed at SessionStart/
  // UserPromptSubmit, and session_end drains. So a daemon nobody has talked
  // to in IDLE_EXIT_MS is pure liability -- it is the long-lived process
  // that goes stale across a `twing-cli` upgrade and then squats the socket
  // at the old version (GitHub issue #20's 8-day orphan). Bounding its
  // lifetime makes that failure mode structurally impossible rather than
  // something eviction has to clean up after.
  //
  // Nothing is lost by exiting: the Go hook's self-heal
  // (hook/daemon_launch.go) starts a fresh daemon from the launch marker
  // the moment one is needed again, and every piece of state that matters
  // across a restart is already durable -- transcript watermarks are on
  // disk, notice cursors re-fetch, claims are TTL'd, and the pending batch
  // is flushed by `stopAndFlush` above.
  let idleTimer: ReturnType<typeof setTimeout>;
  const armIdleExit = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => void onShutdownRequested(), IDLE_EXIT_MS);
    // Never hold the event loop open on the idle timer's own account: it
    // exists to end the process, not to keep it alive.
    idleTimer.unref?.();
  };

  // A completed self-update leaves this process running the code it just
  // replaced. Cycling it is the point: the hook's self-heal starts a fresh
  // daemon from the launch marker the update rewrote, so the new binary,
  // CLI and daemon all match the coordinator.
  syncer.onSelfUpdated = async () => {
    console.log("twing daemon: self-updated; shutting down so a fresh daemon starts on the new code");
    await onShutdownRequested();
  };

  const server = net.createServer((conn) => {
    // Any client at all counts as activity -- a connection is what a live
    // session looks like from here, regardless of which message it carries.
    armIdleExit();
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

  // Only after the socket is genuinely bound: a pidfile written earlier
  // would name a process that lost the race, which is exactly the kind of
  // stale bookkeeping the identity work exists to stop trusting.
  writePidFile(socketPath);

  // Start the clock now, not on the first connection: a daemon spawned by a
  // session that then dies before ever connecting must still exit on its
  // own rather than linger forever.
  armIdleExit();

  return {
    socketPath,
    claims,
    callEdges,
    close: async () => {
      clearTimeout(idleTimer);
      await syncer.stopAndFlush();
      await new Promise<void>((resolve) => {
        server.close(() => {
          removePidFile(socketPath);
          if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
          resolve();
        });
      });
    },
  };
}

function writePidFile(socketPath: string): void {
  try {
    fs.writeFileSync(daemonPidFilePath(socketPath), `${process.pid}\n`);
  } catch {
    // Best-effort: a daemon that can't write its pidfile still runs, it's
    // just harder to evict later. Never a reason to refuse to start.
  }
}

function removePidFile(socketPath: string): void {
  try {
    // Only ours -- a pidfile naming someone else belongs to whoever won the
    // socket after us, and deleting it would strand them.
    if (readPidFile(socketPath) === process.pid) fs.unlinkSync(daemonPidFilePath(socketPath));
  } catch {
    // Already gone, or unwritable. Nothing to do either way.
  }
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
    // Conversation capture rides along on the message that already fires
    // on every SessionStart/UserPromptSubmit, off the reply path: the hook
    // gets its notices at the same speed as before, and capture is
    // watermark-based so a dropped pass costs nothing but latency.
    startCapture({ sessionId: req.sessionId, cwd: req.cwd, transcriptPath: req.transcriptPath });
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

  if (message.type === "session_end") {
    // Fire-and-forget from the hook, so no ack: one last drain of whatever
    // the transcript gained after the session's final prompt.
    const req = raw as SessionEndMessage;
    startCapture({ sessionId: req.sessionId, cwd: req.cwd, transcriptPath: req.transcriptPath });
    return;
  }

  if (message.type === "get_identity") {
    conn.write(encodeFrame({ type: "identity", pid: process.pid, version: daemonVersion, startedAt: STARTED_AT }));
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

/** Capture never blocks a hook reply and never fails one: same
 * ack-immediately-then-work-async shape `enqueue` uses, with every error
 * logged and swallowed. */
function startCapture(input: { sessionId: string; cwd?: string; transcriptPath?: string }): void {
  if (!input.transcriptPath) return;
  captureSession(input)
    .then((result) => {
      if (result.turnsWritten > 0 || result.pathsWritten > 0) {
        console.log(`twing daemon: captured ${result.turnsWritten} turns, ${result.pathsWritten} new paths for session ${input.sessionId}`);
      }
    })
    .catch((err) => {
      console.error("twing daemon: session capture failed", err);
    });
}
