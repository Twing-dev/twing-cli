/**
 * Daemon socket wire protocol -- twing-hook <-> twing daemon (§4/§5), and
 * (from §6) the `twing` CLI <-> daemon for `align`/`review`'s
 * "ask the daemon for the live claim set" path. Length-prefixed JSON frames
 * over a Unix domain socket. The Go hook client never parses `toolInput` —
 * it forwards tool fields verbatim; the daemon (which owns Tree-sitter, §5)
 * does all interpretation.
 */

import type { Claim, CallEdge } from "./types.js";

export type HookToolName = "Edit" | "Write" | "Read" | "Grep" | "Glob";

export interface EnqueueMessage {
  type: "enqueue";
  sessionId: string;
  cwd: string;
  toolName: HookToolName;
  /** Raw tool_input fields forwarded verbatim, never parsed by the hook. */
  toolInput: Record<string, unknown>;
}

export interface AckMessage {
  type: "ack";
}

export interface GetNoticesMessage {
  type: "get_notices";
  sessionId: string;
}

export interface NoticeItem {
  message: string;
}

/** Populated on `get_notices` whenever the daemon has learned (via its own
 * periodic `/v1/version` check against a known coordinator, `daemon/sync.ts`'s
 * `Syncer.versionMismatch()`) that this machine's `@twing/cli` version
 * doesn't match what the coordinator declares. Independent of `items`/the
 * per-developer notice cache -- this must surface even for a session with no
 * prior claims in this project (see `Syncer.versionMismatch()`'s doc
 * comment for the one known gap: the very first `SessionStart` on a machine,
 * before any claim has taught the daemon which server to check). */
export interface VersionMismatchInfo {
  clientVersion: string;
  serverVersion: string;
}

export interface NoticesMessage {
  type: "notices";
  items: NoticeItem[];
  versionMismatch?: VersionMismatchInfo;
}

/** CLI -> daemon: ask a running daemon (however it was started -- foreground,
 * spawn-daemon.ts's detached fallback, or an installed OS service) to exit
 * cleanly, so `twing daemon restart` doesn't rely on OS signals alone. Only
 * used on the no-service-installed path (`daemon-restart.ts`) -- an
 * installed launchd/systemd service is restarted via the service manager
 * directly instead, since systemd's `Restart=on-failure` does not respawn
 * on a clean exit. */
export interface ShutdownMessage {
  type: "shutdown";
}

export interface ShutdownAckMessage {
  type: "shutdown_ack";
}

/** CLI -> daemon (§6): "ask it for the live claim set" for the repo at
 * `cwd`, scoped by the projectId that repo derives to (§8). */
export interface GetClaimsMessage {
  type: "get_claims";
  cwd: string;
}

export interface ClaimsMessage {
  type: "claims";
  claims: Claim[];
  callEdges: CallEdge[];
}

export type HookToDaemonMessage = EnqueueMessage | GetNoticesMessage;
export type CliToDaemonMessage = GetClaimsMessage | ShutdownMessage;
export type DaemonToHookMessage = AckMessage | NoticesMessage;
export type DaemonToCliMessage = ClaimsMessage | ShutdownAckMessage;
export type ProtocolMessage = HookToDaemonMessage | CliToDaemonMessage | DaemonToHookMessage | DaemonToCliMessage;

/**
 * `Edit`/`Write` are firm claims (artifact-grade); `Read`/`Grep`/`Glob` are
 * soft claims. Derived here from `toolName` rather than sent on the wire,
 * since the daemon already owns this mapping and the hook stays a dumb pipe.
 *
 * The hook still enqueues `Read`/`Grep`/`Glob` events same as before (§4's
 * capture table is unchanged, and this function still answers "soft" for
 * them correctly) — but as of 2026-08-22, `daemon/claims.ts`'s
 * `extractClaim` stops before ever calling this for a non-write event and
 * returns null instead, so no soft `Claim` actually gets constructed/synced
 * downstream of the daemon anymore (reported as pure noise, no consumer
 * needed it enough to keep it). This function and the wire-level "soft"
 * concept stay as-is; only the daemon's own decision to act on it changed.
 */
export function stageForTool(toolName: HookToolName): "soft" | "firm" {
  return toolName === "Edit" || toolName === "Write" ? "firm" : "soft";
}
