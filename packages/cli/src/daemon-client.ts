/**
 * `align`'s "ask the daemon for the live claim set" path (§6 step 1).
 * A short-lived client connection, not the persistent hook protocol.
 */

import * as net from "node:net";
import { FrameDecoder, encodeFrame, defaultSocketPath, type Claim, type CallEdge, type Notice } from "@twing/core";

const QUERY_TIMEOUT_MS = 500;

export interface DaemonClaims {
  claims: Claim[];
  callEdges: CallEdge[];
}

/**
 * Generic one-shot request/response over the daemon socket: write one
 * frame, resolve on the first frame matching `responseType`, timeout or
 * connection failure resolves null rather than rejecting -- every caller
 * here treats "the daemon didn't answer" as "fall back", never an error.
 */
function queryDaemon<T>(request: unknown, responseType: string, extract: (msg: any) => T): Promise<T | null> {
  return new Promise((resolve) => {
    const decoder = new FrameDecoder();
    let settled = false;

    const conn = net.createConnection(defaultSocketPath());

    const finish = (result: T | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => finish(null), QUERY_TIMEOUT_MS);

    conn.once("connect", () => conn.write(encodeFrame(request)));
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
        const msg = raw as { type?: string };
        if (msg.type === responseType) finish(extract(msg));
      }
    });
  });
}

/** Returns null if the daemon isn't running or doesn't answer in time --
 * callers fall back to computing claims directly from git diff (§6). */
export function queryDaemonClaims(cwd: string): Promise<DaemonClaims | null> {
  return queryDaemon({ type: "get_claims", cwd }, "claims", (msg) => ({
    claims: (msg.claims ?? []) as Claim[],
    callEdges: (msg.callEdges ?? []) as CallEdge[],
  }));
}

/**
 * The daemon's own background sync (§5) may already have discovered a
 * cross-session finding by the time `align` runs -- its polling
 * loop feeds the hook's cache-check, but `align`'s own POST won't
 * re-surface it if the claim it's resubmitting is unchanged from what the
 * daemon already pushed (the server correctly treats that as a no-op, not
 * a new finding). Reusing get_notices here, keyed by a sessionId the
 * daemon already has on file, closes that gap without a protocol change.
 */
export function queryDaemonNotices(sessionId: string): Promise<Notice[] | null> {
  return queryDaemon({ type: "get_notices", sessionId }, "notices", (msg) => (msg.items ?? []) as Notice[]);
}

/** `twing daemon restart`'s no-service-installed path (daemon-restart.ts):
 * ask a running daemon to exit cleanly over the socket rather than relying
 * on OS signals alone. Resolves false the same way every other query here
 * treats "the daemon didn't answer" -- not running, or already gone. */
export function requestDaemonShutdown(): Promise<boolean> {
  return queryDaemon({ type: "shutdown" }, "shutdown_ack", () => true).then((r) => r ?? false);
}
