/**
 * OpenCode's conversation store, as a `TranscriptSource`.
 *
 * OpenCode keeps conversations in one machine-global SQLite database
 * (`$XDG_DATA_HOME/opencode/opencode.db`, defaulting to `~/.local/share`),
 * not a file per session: `message`
 * rows carry `{role, time: {created, completed?}, ...}` as JSON, and `part`
 * rows hang off them carrying the actual text and tool calls.
 *
 * **Why the cursor is `(time_created, id)` and not a row count.** Rows are
 * mutated after insert -- measured on a real database, 69 of 69 messages and
 * 278 of 290 parts had `time_updated > time_created`. An assistant message is
 * written when it starts and rewritten as it streams, so "everything after
 * row N" is not a stable idea and neither is any offset-like number. What
 * *is* stable is the pair of a message's creation time and its id, and that
 * pair is totally ordered.
 *
 * **Why only completed messages are handed over.** A user message is finished
 * the moment it exists; an assistant message gains `time.completed` when it
 * stops streaming. Emitting an assistant message before then would capture
 * half its text and move the cursor past it, so the rest would never be
 * captured at all. So the read stops at the first incomplete assistant
 * message and leaves it for the next pass -- exactly what
 * `ClaudeCodeJsonlSource` does with a partial trailing line, for exactly the
 * same reason.
 *
 * **Why translation lives here.** `filterTranscriptEntry` (`@twing/core`)
 * reads Claude Code's entry shape. Rather than teach it a second dialect,
 * this source translates OpenCode's rows into that shape, so consent,
 * filtering, redaction, the capture file and upload stay one implementation
 * with nothing harness-specific in them. The interface's whole point is that
 * only this layer forks.
 *
 * **`node:sqlite`** is used rather than `better-sqlite3`: it is built in from
 * Node 22.5 (twing's floor), so it adds no native dependency to a package
 * that is installed unattended onto other people's machines -- `install.sh`
 * deliberately runs `npm install --ignore-scripts`, which a native module
 * could not survive. It is still flagged experimental, hence the guarded
 * import and the `available()` check: a capture that cannot run degrades to
 * nothing captured, never to a thrown error on the daemon's event loop.
 */

import * as os from "node:os";
import * as path from "node:path";
import { patchPaths } from "../opencode-adapter.js";
import { registerTranscriptSource, type Cursor, type TranscriptEntry, type TranscriptSource } from "./transcript-source.js";

/**
 * Where OpenCode keeps its database.
 *
 * `XDG_DATA_HOME` is honoured because OpenCode honours it -- verified against
 * the shipped binary, which reports `data /tmp/probe/opencode` when it is set
 * (and note it is `data`, not the `state` directory OpenCode's own plugin API
 * exposes: those are two different paths and only one has a database in it).
 *
 * The environment has to be *passed in* rather than read from `process.env`.
 * The daemon is a long-lived process shared by every session on the machine
 * and is usually started by something other than the shell running OpenCode,
 * so its own environment says nothing about where this session's OpenCode
 * keeps its data. The adapter, which runs inside OpenCode, is the only party
 * that knows -- see `TranscriptSourceDescriptor`.
 */
export function openCodeDbPath(xdgDataHome?: string): string {
  const dataHome = xdgDataHome && xdgDataHome.trim() !== ""
    ? xdgDataHome
    : path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "opencode", "opencode.db");
}

/** @deprecated Use `openCodeDbPath`, which honours `XDG_DATA_HOME`. Kept for
 * the tests and scripts that name it. */
export function defaultOpenCodeDbPath(): string {
  return openCodeDbPath();
}

const TIME_PREFIX = "t:";

/** `t:<time_created>,<id>`. Prefixed so it can never be mistaken for
 * `ClaudeCodeJsonlSource`'s `b:<offset>`, and so a state file read by hand
 * says which source wrote it. */
function timeCursor(timeCreated: number, id: string): Cursor {
  return `${TIME_PREFIX}${timeCreated},${id}`;
}

interface CursorParts {
  timeCreated: number;
  id: string;
}

export function parseTimeCursor(cursor: string | undefined): CursorParts | undefined {
  if (cursor === undefined || !cursor.startsWith(TIME_PREFIX)) return undefined;
  const rest = cursor.slice(TIME_PREFIX.length);
  const comma = rest.indexOf(",");
  if (comma <= 0) return undefined;
  const timeCreated = Number(rest.slice(0, comma));
  const id = rest.slice(comma + 1);
  if (!Number.isSafeInteger(timeCreated) || timeCreated < 0 || id === "") return undefined;
  return { timeCreated, id };
}

/** The minimal shape this source needs from `node:sqlite`, so the import can
 * be swapped in tests without a real database engine. */
export interface SqliteRow {
  id: string;
  time_created: number;
  data: string;
}
export interface SqliteReader {
  messages(sessionId: string, after: CursorParts | undefined): SqliteRow[];
  parts(messageId: string): { data: string }[];
  close(): void;
}

/**
 * Open the database read-only, or `undefined` if that is not possible.
 *
 * Every failure is the same answer -- `node:sqlite` missing (Node below the
 * floor, or a build without it), the file absent (OpenCode never run here),
 * or unreadable. None of them is an error worth propagating: OpenCode capture
 * simply does not happen on this machine.
 *
 * Read-only matters for more than politeness: OpenCode is usually running
 * while this reads, and opening read-only lets SQLite read the WAL without
 * ever taking a write lock on a database another process owns.
 */
export async function openSqliteReader(dbPath: string): Promise<SqliteReader | undefined> {
  let DatabaseSync: new (p: string, o?: { readOnly?: boolean }) => {
    prepare(sql: string): { all(...p: unknown[]): unknown[] };
    close(): void;
  };
  try {
    ({ DatabaseSync } = (await import("node:sqlite")) as never);
  } catch {
    return undefined; // no node:sqlite in this runtime
  }

  let db: { prepare(sql: string): { all(...p: unknown[]): unknown[] }; close(): void };
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return undefined; // absent, unreadable, or not a database
  }

  try {
    // Ordered by the cursor's own key so paging is a continuation, not a
    // re-sort. `>` on the pair is expressed the portable way rather than as a
    // row-value comparison, which older SQLite builds do not accept.
    const messageStmt = db.prepare(
      "SELECT id, time_created, data FROM message" +
        " WHERE session_id = ?" +
        " AND (time_created > ? OR (time_created = ? AND id > ?))" +
        " ORDER BY time_created ASC, id ASC",
    );
    const allStmt = db.prepare("SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC");
    const partStmt = db.prepare("SELECT data FROM part WHERE message_id = ? ORDER BY id ASC");
    return {
      messages(sessionId, after) {
        const rows = after === undefined
          ? allStmt.all(sessionId)
          : messageStmt.all(sessionId, after.timeCreated, after.timeCreated, after.id);
        return rows as SqliteRow[];
      },
      parts(messageId) {
        return partStmt.all(messageId) as { data: string }[];
      },
      close() {
        try {
          db.close();
        } catch {
          /* closing a database we only read is never worth failing over */
        }
      },
    };
  } catch {
    try {
      db.close();
    } catch { /* ignore */ }
    return undefined; // schema is not what this source understands
  }
}

interface OpenCodeMessage {
  role?: string;
  time?: { created?: number; completed?: number };
}

/** Whether a message is finished and safe to hand over. A user message is
 * finished when it exists; an assistant message only once it stops
 * streaming. */
function isComplete(message: OpenCodeMessage): boolean {
  if (message.role === "user") return true;
  return typeof message.time?.completed === "number";
}

/**
 * OpenCode's tool inputs are camelCase (`filePath`), Claude Code's are
 * snake_case (`file_path`), and `collectPaths` in `transcript-filter.ts`
 * matches a fixed key list -- deliberately, so a Bash `command` can't smuggle
 * tool content in as a path. So OpenCode's spelling has to be translated
 * here, or every entry names zero paths: `reposForEntry` then resolves no
 * repo, consent never triggers, and capture silently does nothing at all on
 * OpenCode while looking entirely healthy.
 *
 * Verified against a live database: `read`/`edit`/`write` use `filePath`;
 * `glob`/`grep` use `path`, which already matches. Renaming rather than
 * widening the core allowlist is the point of this layer -- `@twing/core`
 * stays Claude-Code-shaped and only this file knows a second dialect.
 *
 * `apply_patch` needs more than a rename: it carries its paths *inside*
 * `patchText` (`*** Update File: /abs/path`) rather than in any field, so a
 * key scan finds nothing and the edit attributes to no repo at all. That was
 * left unparsed as "safe in the safe direction" -- an undetected touch means
 * the session is not captured, never that an unconsented repo is -- on the
 * reasoning that a `read` usually precedes the patch and carries consent on
 * its own. "Usually" is doing too much work there: an agent that patches a
 * file it already has in context reads nothing first, and the same envelope
 * is now parsed on the Codex side, where it is the *only* way a session names
 * a file. So it is parsed here too, by the same function
 * (`opencode-adapter.ts`'s `patchPaths`), which is also the one the adapter
 * uses to decide what to gate -- capture and the gate then agree about which
 * files a patch touched, rather than disagreeing silently.
 */
const OPENCODE_PATH_KEYS: Record<string, string> = { filePath: "file_path", notebookPath: "notebook_path" };

function translateToolInput(input: unknown, directory?: string): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input ?? {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const renamed = OPENCODE_PATH_KEYS[key] ?? key;
    out[renamed] = PATH_VALUED_KEYS.has(renamed) && typeof value === "string" ? absolute(value, directory) : value;
  }

  // A patch names its files in its own body. `collectPaths` reads a fixed
  // list of keys and will never look inside one, so the targets are lifted
  // out here into the key it does read. Several files in one patch stay
  // several entries: `collectPaths` recurses into arrays for exactly this
  // shape (Claude's multi-edit form).
  const patch = firstString(input as Record<string, unknown>, ["patchText", "patch_text", "patch", "input"]);
  if (patch && patch.includes("*** ")) {
    const targets = patchPaths(patch);
    if (targets.length > 0) out.edits = targets.map((file) => ({ file_path: absolute(file, directory) }));
  }
  return out;
}

/** The keys `collectPaths` (`transcript-filter.ts`) reads as paths, after the
 * rename above. */
const PATH_VALUED_KEYS = new Set(["file_path", "notebook_path", "path"]);

/**
 * A path the capture pipeline can attribute on its own.
 *
 * Relative is not good enough, even though `reposForEntry` would resolve one
 * against the entry's cwd: `transcript.ts`'s projectId pass sees only the
 * bare string, and resolves it against the *daemon's* working directory --
 * a process serving every repo on the machine. A session's edit then gets
 * labelled with whichever repo the daemon happened to start in. Found on the
 * Codex side first (`codex-rollout-source.ts` resolves for the same reason);
 * OpenCode's patch targets had the identical shape, which an external review
 * caught before it was shipped.
 */
function absolute(candidate: string, directory: string | undefined): string {
  if (!directory || path.isAbsolute(candidate)) return candidate;
  return path.resolve(directory, candidate);
}

/** The first of these keys holding a non-empty string. */
function firstString(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * One OpenCode message plus its parts, in the entry shape
 * `filterTranscriptEntry` already reads.
 *
 * Only `text` and `tool` parts are translated. `reasoning` is dropped on
 * purpose -- it is the model's private chain of thought, and the Claude Code
 * side drops thinking blocks by the same construction (its filter allows
 * `text` and `tool_use` and nothing else). `step-start`/`step-finish` are
 * bookkeeping. Anything new OpenCode adds is dropped until someone decides
 * otherwise, which is the same allowlist posture `transcript-filter.ts` takes
 * toward new Claude Code entry types.
 */
export function toTranscriptEntryShape(message: OpenCodeMessage, parts: unknown[], directory?: string): unknown {
  const content: unknown[] = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const p = part as { type?: string; text?: unknown; state?: { input?: unknown } };
    if (p.type === "text" && typeof p.text === "string") {
      content.push({ type: "text", text: p.text });
    } else if (p.type === "tool") {
      // The paths a tool call names are the only thing kept from it, which is
      // what `collectPaths` will pull out of `input`. Output, metadata and
      // timings are dropped here rather than filtered later.
      content.push({ type: "tool_use", input: translateToolInput(p.state?.input, directory) });
    }
  }
  const created = message.time?.created;
  return {
    type: message.role === "user" ? "user" : "assistant",
    ...(typeof created === "number" ? { timestamp: new Date(created).toISOString() } : {}),
    ...(directory ? { cwd: directory } : {}),
    message: { role: message.role, content },
  };
}

export class OpenCodeSqliteSource implements TranscriptSource {
  readonly kind = "opencode-sqlite";
  /** No `t:` pair precedes every row, so "before the first entry" is the
   * empty string rather than a synthetic pair -- `parseTimeCursor` returns
   * undefined for it, which `messages()` reads as "from the beginning". */
  readonly beginning: Cursor = "";

  constructor(
    private readonly dbPath: string,
    private readonly sessionId: string,
    /** Injected in tests; production opens the real database. */
    private readonly open: (p: string) => Promise<SqliteReader | undefined> = openSqliteReader,
    private readonly directory?: string,
  ) {}

  async exists(): Promise<boolean> {
    const reader = await this.open(this.dbPath);
    if (!reader) return false;
    reader.close();
    return true;
  }

  /** A cursor from another source, or a corrupt one, reads as "start over".
   * Unlike the JSONL source there is nothing to bounds-check against: a pair
   * naming a row that has since been deleted simply selects everything after
   * it, which is the correct answer. */
  async resume(stored: string | undefined): Promise<Cursor> {
    return parseTimeCursor(stored) ? stored! : this.beginning;
  }

  async atEnd(cursor: Cursor): Promise<boolean> {
    const reader = await this.open(this.dbPath);
    if (!reader) return true;
    try {
      for (const row of reader.messages(this.sessionId, parseTimeCursor(cursor))) {
        if (isComplete(JSON.parse(row.data) as OpenCodeMessage)) return false;
      }
      return true;
    } catch {
      return true;
    } finally {
      reader.close();
    }
  }

  async read(cursor: Cursor, onEntry: (entry: TranscriptEntry) => void): Promise<Cursor> {
    const reader = await this.open(this.dbPath);
    if (!reader) return cursor;
    let reached = cursor;
    try {
      for (const row of reader.messages(this.sessionId, parseTimeCursor(cursor))) {
        let message: OpenCodeMessage;
        try {
          message = JSON.parse(row.data) as OpenCodeMessage;
        } catch {
          // A row we cannot parse is skipped, never fatal -- but the cursor
          // still advances past it, or every later pass would stop here.
          reached = timeCursor(row.time_created, row.id);
          continue;
        }
        // Stop, do not skip: an assistant message still streaming will be
        // complete on a later pass, and advancing past it would lose it.
        if (!isComplete(message)) break;

        const parts: unknown[] = [];
        for (const p of reader.parts(row.id)) {
          try {
            parts.push(JSON.parse(p.data));
          } catch {
            /* one unreadable part must not drop the whole message */
          }
        }
        reached = timeCursor(row.time_created, row.id);
        onEntry({ value: toTranscriptEntryShape(message, parts, this.directory), after: reached });
      }
      return reached;
    } catch {
      // A database that went away mid-read leaves the cursor where it was;
      // the next pass re-reads from there rather than losing the gap.
      return reached;
    } finally {
      reader.close();
    }
  }
}

// `directory` stays optional rather than `required` even though the adapter
// now always sends it: an adapter copy is refreshed with the package, so a
// machine mid-upgrade has a new daemon reading descriptors from an older
// adapter that predates the key. Absent, it degrades to exactly the old
// behaviour -- relative paths left relative -- rather than failing to resolve
// a source at all. `sessionId` is not optional: without it this would read
// every project's conversation out of a shared database.
registerTranscriptSource("opencode-sqlite", ["sessionId"], (values) =>
  new OpenCodeSqliteSource(openCodeDbPath(values.xdgDataHome), values.sessionId, openSqliteReader, values.directory));
