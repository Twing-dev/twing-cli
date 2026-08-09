/**
 * twing-hook <-> twing daemon wire protocol.
 *
 * Design doc §4/§5: length-prefixed JSON frames over a Unix domain socket.
 * The Go hook client never parses `toolInput` — it forwards tool fields
 * verbatim; the daemon (which owns Tree-sitter, §5) does all interpretation.
 */

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

export type HookToDaemonMessage = EnqueueMessage | GetNoticesMessage;
export type DaemonToHookMessage = AckMessage | NoticesMessage;
export type ProtocolMessage = HookToDaemonMessage | DaemonToHookMessage;

/**
 * `Edit`/`Write` are firm claims (artifact-grade); `Read`/`Grep`/`Glob` are
 * soft claims. Derived here from `toolName` rather than sent on the wire,
 * since the daemon already owns this mapping and the hook stays a dumb pipe.
 */
export function stageForTool(toolName: HookToolName): "soft" | "firm" {
  return toolName === "Edit" || toolName === "Write" ? "firm" : "soft";
}
