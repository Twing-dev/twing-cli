/**
 * The capture contract, as a pure function over one line of Claude Code's
 * session transcript JSONL. No I/O, no state: `daemon/transcript.ts` owns
 * the watermark, redaction and the append; this owns only "what survives".
 *
 * Why a transcript and not the hook stream: `hook/main.go` only forwards
 * `Edit|Write|Read|Grep|Glob`, and a real session's tool traffic is mostly
 * neither (Bash alone was 59.7% of 5,867 calls in the session this filter
 * was built against, while Grep/Glob were used zero times). The transcript
 * has every call, so reading it needs no new decision logic at the capture
 * edge -- the hook stays the trivial socket client §4 requires.
 *
 * Keep: genuine human turns, assistant prose, and the set of file paths
 * touched (repo attribution, and later the fold's routing, which already
 * keys on paths).
 *
 * Drop: every tool input and result -- tool *results* entirely, Bash output
 * included. Measured against a real 90MB transcript, every irreproducible
 * finding in it was already narrated in assistant prose in a
 * distillation-ready form; keeping the raw output would cost ~16MB to
 * preserve material a later fold compresses back to roughly the sentence
 * already captured. Also dropped: the harness-injected noise a naive
 * `role === "user"` filter lets straight through -- `<system-reminder>`
 * blocks, the `<command-name>`/`<command-message>`/`<command-args>`/
 * `<local-command-stdout>`/`<local-command-caveat>` family, hook
 * `additionalContext` (which arrives as its own `attachment` entry), and
 * compaction summaries.
 *
 * Compaction summaries are dropped on purpose, not for size: compaction is
 * a *recursive* lossy filter (each summary is built from the previous
 * summary, never the original), measured at a 28% concrete-fact survival
 * rate per generation. Capturing them would be capturing the very decay
 * this exists to route around.
 */

/** One captured line. `turn` records carry conversation; `paths` records
 * carry the file paths a stretch of the session touched, batched rather
 * than one record per tool call. */
export type CapturedRecord =
  | { type: "turn"; role: "user" | "assistant"; ts?: string; text: string }
  | { type: "paths"; ts?: string; paths: string[] };

export interface FilteredEntry {
  /** The conversation turn this entry contributed, if any. */
  turn?: { role: "user" | "assistant"; ts?: string; text: string };
  /** File paths this entry touched (tool-call inputs and the entry's own
   * cwd) -- collected even from entries whose turn is dropped, since a
   * tool_use block is dropped as *content* but is exactly where the paths
   * live. */
  paths: string[];
  /** The entry's own `cwd`, when it declares one. A single session can span
   * several repos (the transcript this was built against spanned three), so
   * this is per-entry, never assumed constant for a session. */
  cwd?: string;
}

const EMPTY: FilteredEntry = { paths: [] };

/** Tool-input keys that hold a file path. Deliberately a fixed list rather
 * than "any string that looks path-ish": a Bash `command` or a Grep
 * `pattern` can contain anything, and guessing there would smuggle tool
 * content back in through the one field we said we'd keep. */
const PATH_KEYS = new Set(["file_path", "notebook_path", "path"]);

const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/** The `<command-*>`/`<local-command-*>` family, which Claude Code injects
 * as a `role: "user"` message when a slash command runs -- indistinguishable
 * from a human turn by role alone, which is the whole reason this filter
 * exists rather than a `role === "user"` check. */
const COMMAND_WRAPPER = /^\s*<(?:command-name|command-message|command-args|local-command-stdout|local-command-caveat)>/;

interface TranscriptEntry {
  type?: string;
  timestamp?: string;
  cwd?: string;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  isSidechain?: boolean;
  message?: {
    role?: string;
    content?: unknown;
  };
}

/**
 * Reduces one already-parsed transcript entry to what the contract keeps.
 * Returns an entry with no `turn` (and possibly no paths) for everything
 * dropped -- never throws, since a malformed or newly-invented entry shape
 * must degrade to "captured nothing", not break the capture.
 */
export function filterTranscriptEntry(raw: unknown): FilteredEntry {
  if (!raw || typeof raw !== "object") return EMPTY;
  const entry = raw as TranscriptEntry;

  // Everything that isn't a conversation entry: `attachment` (where hook
  // additionalContext, images and system reminders land), `system`,
  // `file-history-snapshot`, and the pile of single-purpose bookkeeping
  // types (`ai-title`, `mode`, `queue-operation`, ...). None of them is
  // conversation, and new ones appear between Claude Code versions -- an
  // allowlist of two keeps that churn out of the capture by construction.
  if (entry.type !== "user" && entry.type !== "assistant") return EMPTY;

  const role = entry.type;
  const ts = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
  const cwd = typeof entry.cwd === "string" ? entry.cwd : undefined;
  const paths: string[] = [];

  const content = entry.message?.content;
  const blocks: unknown[] = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];

  const texts: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; text?: unknown; name?: unknown; input?: unknown };
    if (b.type === "text" && typeof b.text === "string") {
      texts.push(b.text);
    } else if (b.type === "tool_use") {
      // The one thing a tool call contributes: the paths it names. Its
      // input and (elsewhere) its result are dropped whole.
      collectPaths(b.input, paths);
    }
    // `thinking`, `tool_result`, `image`, and anything else: dropped.
  }

  if (cwd) paths.push(cwd);

  // Compaction summaries arrive as an ordinary `role: "user"` text message
  // -- see this file's header for why they're dropped rather than kept.
  if (entry.isCompactSummary) return { paths, cwd };
  // `isMeta` is Claude Code's own marker for a turn it injected on the
  // user's behalf (the local-command caveat, image dimension notes).
  if (entry.isMeta) return { paths, cwd };

  const text = texts
    .map((t) => t.replace(SYSTEM_REMINDER, "").trim())
    .filter((t) => t.length > 0 && !COMMAND_WRAPPER.test(t))
    .join("\n\n")
    .trim();

  if (text.length === 0) return { paths, cwd };
  return { turn: { role, ts, text }, paths, cwd };
}

function collectPaths(input: unknown, out: string[]): void {
  if (Array.isArray(input)) {
    // `Edit`'s multi-edit form nests `{file_path, ...}` objects one level
    // down, so a plain top-level key scan would miss them.
    for (const item of input) collectPaths(item, out);
    return;
  }
  if (!input || typeof input !== "object") return;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (PATH_KEYS.has(key) && typeof value === "string" && value.length > 0) out.push(value);
    else if (value && typeof value === "object") collectPaths(value, out);
  }
}
