/**
 * Daemon socket wire protocol -- twing-hook <-> twing daemon (§4/§5), and
 * (from §6) the `twing` CLI <-> daemon for `review-design`/`review-code`'s
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

export interface NoticesMessage {
  type: "notices";
  items: NoticeItem[];
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
export type CliToDaemonMessage = GetClaimsMessage;
export type DaemonToHookMessage = AckMessage | NoticesMessage;
export type DaemonToCliMessage = ClaimsMessage;
export type ProtocolMessage = HookToDaemonMessage | CliToDaemonMessage | DaemonToHookMessage | DaemonToCliMessage;

/**
 * `Edit`/`Write` are firm claims (artifact-grade); `Read`/`Grep`/`Glob` are
 * soft claims. Derived here from `toolName` rather than sent on the wire,
 * since the daemon already owns this mapping and the hook stays a dumb pipe.
 */
export function stageForTool(toolName: HookToolName): "soft" | "firm" {
  return toolName === "Edit" || toolName === "Write" ? "firm" : "soft";
}
