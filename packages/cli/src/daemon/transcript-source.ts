/**
 * Where a session's raw conversation comes from, as an interface.
 *
 * `transcript.ts` used to read Claude Code's JSONL directly, and every step
 * of it was phrased in byte offsets: stat the file for its size, compare the
 * watermark against it, stream `[from, to)`, record the offset of the last
 * complete line. That works because a JSONL transcript is append-only -- a
 * byte offset is a position, an ordering and a "how much is left" all at
 * once.
 *
 * No other harness gives us that. OpenCode keeps conversations in SQLite and
 * **mutates rows after inserting them** (measured on a real database: 69 of
 * 69 messages and 278 of 290 parts carried `time_updated > time_created`),
 * so there is no monotonic byte count to hold on to and no way to phrase
 * "everything after here" as a number.
 *
 * So the watermark becomes opaque. A `Cursor` is a string this module's
 * implementations mint and interpret; nothing outside a source may parse
 * one, compare two, or do arithmetic on one. `transcript.ts` moves it around
 * and persists it, and that is all it is allowed to know.
 *
 * What deliberately stays *out* of here: consent (which repos opted in,
 * where the boundary falls), filtering, redaction, and the capture file.
 * Those are identical for every harness and live in `transcript.ts`. This
 * interface answers exactly one question -- how do I read this conversation
 * forward from a position -- and nothing else.
 */

import * as fsp from "node:fs/promises";

/**
 * An opaque position in a transcript.
 *
 * Treat it as a token, never as data: the only valid operations are getting
 * one from a source, handing it back to the same source, and storing it.
 * `ClaudeCodeJsonlSource` happens to encode a byte offset, which is exactly
 * the kind of thing a caller must not rely on.
 */
export type Cursor = string;

/** One raw transcript record, with the position immediately after it. */
export interface TranscriptEntry {
  /** The parsed record, handed to `filterTranscriptEntry` unmodified. */
  value: unknown;
  /** The cursor pointing just past this entry -- what a caller stores if it
   * wants to resume *after* having consumed this one. */
  after: Cursor;
}

export interface TranscriptSource {
  /** Which implementation this is. Diagnostics only; never branched on. */
  readonly kind: string;

  /** The position before the first entry. */
  readonly beginning: Cursor;

  /** Whether the underlying transcript is readable at all. A transcript can
   * legitimately be gone -- a deleted session, or a path belonging to
   * another machine in a synced home directory -- which is not an error. */
  exists(): Promise<boolean>;

  /**
   * Turn a cursor recovered from a state file into one safe to read from.
   *
   * A transcript that shrank, rotated, or now belongs to a different session
   * makes a stored cursor describe content that no longer exists; every such
   * case resolves to `beginning` rather than reading from the middle of a
   * record. Callers persist whatever this returns.
   */
  resume(stored: string | undefined): Promise<Cursor>;

  /** Whether anything follows this cursor. Separate from `read` so a pass
   * with nothing new writes no file and allocates nothing. */
  atEnd(cursor: Cursor): Promise<boolean>;

  /**
   * Read forward from `cursor`, handing over each complete entry in order,
   * and resolve to the position reached.
   *
   * A partial trailing record is deliberately *not* included: the harness is
   * still writing this transcript while we read it, so the returned cursor
   * stops at the last complete entry and the next pass picks up the
   * remainder whole.
   */
  read(cursor: Cursor, onEntry: (entry: TranscriptEntry) => void): Promise<Cursor>;
}

/** Read the transcript delta in bounded chunks rather than one big buffer:
 * the first capture of an already-long session can be tens of MB, and a
 * daemon serving every repo on the machine has no business holding that in
 * memory at once. */
const READ_CHUNK_BYTES = 4 * 1024 * 1024;

const BYTE_PREFIX = "b:";

/** Encode a byte offset as a cursor. Prefixed rather than bare so a cursor
 * from a future source is never mistaken for one of ours, and so a stored
 * value's origin is visible when someone opens a state file by hand. */
function byteCursor(offset: number): Cursor {
  return `${BYTE_PREFIX}${offset}`;
}

/**
 * Decode a cursor to a byte offset, or `undefined` if it isn't one of ours.
 *
 * Also accepts a bare number, which is what every state file written before
 * this seam existed holds (`{"offset": 22696087}`). Those files are live on
 * real machines mid-session; misreading one doesn't error, it silently
 * re-reads the whole transcript from zero and re-uploads a session that was
 * already captured.
 */
export function byteOffsetOf(cursor: string | undefined): number | undefined {
  if (cursor === undefined) return undefined;
  const raw = cursor.startsWith(BYTE_PREFIX) ? cursor.slice(BYTE_PREFIX.length) : cursor;
  if (!/^\d+$/.test(raw)) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Claude Code's transcript: newline-delimited JSON, appended to while we
 * read it. The cursor is a byte offset, which is what makes this source the
 * cheap one -- resuming is a seek, and "is there more" is a `stat`.
 */
export class ClaudeCodeJsonlSource implements TranscriptSource {
  readonly kind = "claude-code-jsonl";
  readonly beginning = byteCursor(0);

  constructor(private readonly filePath: string) {}

  async exists(): Promise<boolean> {
    return (await this.size()) !== undefined;
  }

  async resume(stored: string | undefined): Promise<Cursor> {
    const offset = byteOffsetOf(stored);
    if (offset === undefined) return this.beginning;
    const size = await this.size();
    // Past the end means the file shrank or rotated under us.
    if (size === undefined || offset > size) return this.beginning;
    return byteCursor(offset);
  }

  async atEnd(cursor: Cursor): Promise<boolean> {
    const offset = byteOffsetOf(cursor) ?? 0;
    const size = await this.size();
    return size === undefined || offset >= size;
  }

  async read(cursor: Cursor, onEntry: (entry: TranscriptEntry) => void): Promise<Cursor> {
    const from = byteOffsetOf(cursor) ?? 0;
    const to = await this.size();
    if (to === undefined || from >= to) return byteCursor(from);

    const handle = await fsp.open(this.filePath, "r");
    try {
      const buffer = Buffer.alloc(READ_CHUNK_BYTES);
      let position = from;
      let consumed = from;
      let lineStart = from;
      // Carried as bytes, not a string: a UTF-8 sequence split across a chunk
      // boundary would decode to replacement characters (and throw the byte
      // accounting below off) if each chunk were decoded independently.
      let carry = Buffer.alloc(0);

      while (position < to) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(READ_CHUNK_BYTES, to - position), position);
        if (bytesRead === 0) break;
        position += bytesRead;

        const chunk = carry.length === 0 ? Buffer.from(buffer.subarray(0, bytesRead)) : Buffer.concat([carry, buffer.subarray(0, bytesRead)]);
        const lastBreak = chunk.lastIndexOf(0x0a);
        if (lastBreak === -1) {
          carry = chunk;
          continue;
        }

        for (const line of chunk.subarray(0, lastBreak).toString("utf8").split("\n")) {
          // Advance past this line and its terminator. Byte length, not
          // string length: a line carrying any non-ASCII character occupies
          // more bytes than it has characters, and every offset downstream of
          // this is a file position.
          const after = lineStart + Buffer.byteLength(line, "utf8") + 1;
          if (line.length > 0) {
            // A torn or malformed line is skipped, never fatal -- the same
            // trade the byte-offset reader always made.
            let value: unknown;
            try {
              value = JSON.parse(line);
            } catch {
              lineStart = after;
              continue;
            }
            onEntry({ value, after: byteCursor(after) });
          }
          lineStart = after;
        }
        carry = Buffer.from(chunk.subarray(lastBreak + 1));
        consumed = position - carry.length;
      }

      return byteCursor(consumed);
    } finally {
      await handle.close();
    }
  }

  private async size(): Promise<number | undefined> {
    try {
      return (await fsp.stat(this.filePath)).size;
    } catch {
      return undefined;
    }
  }
}

/**
 * Why a source could not be built. Never a thrown error: a session whose
 * conversation cannot be located must still get its notices, its claims and
 * its design gate -- capture is the one part of twing that is allowed to not
 * happen. But it must not be allowed to not happen *quietly*, which is the
 * whole reason this type exists rather than `undefined`.
 *
 * Both bugs found on 2026-09-18 had this shape: a key spelled `filePath`
 * where the filter wanted `file_path`, and a database looked for under
 * `~/.local/share` when the user had moved it. Neither threw, neither logged,
 * and both left a system that looked completely healthy while capturing
 * nothing whatsoever. A reason string is what turns the next one of those
 * into a line in `~/.twing/design-coordinator.log` instead of a silence.
 */
export interface UnresolvedSource {
  kind: string;
  reason: string;
}

export type SourceResolution =
  | { ok: true; source: TranscriptSource }
  | { ok: false; problem: UnresolvedSource };

/** What a descriptor must carry for each kind, and how to build it. Adding a
 * harness means adding an entry here -- not touching the protocol, the Go
 * mirror, or `transcript.ts`. */
const BUILDERS: Record<string, { required: string[]; build: (values: Record<string, string>) => TranscriptSource }> = {};

/** Registered by the modules that implement them, so this file keeps no
 * import of any concrete source but the one it defines. */
export function registerTranscriptSource(
  kind: string,
  required: string[],
  build: (values: Record<string, string>) => TranscriptSource,
): void {
  BUILDERS[kind] = { required, build };
}

registerTranscriptSource("claude-code-jsonl", ["path"], (values) => new ClaudeCodeJsonlSource(values.path));

/**
 * Turn a descriptor into a source, or say why not.
 *
 * Validation is by *name*: a required value that is missing or empty is
 * reported with the key that was wanted. That is deliberately more than a
 * boolean -- when this fails, the person reading the log is looking at a
 * harness adapter they cannot see the source of, and "missing value
 * `sessionId`" is the difference between a fix and an investigation.
 */
export function resolveTranscriptSource(descriptor: { kind: string; values: Record<string, string> }): SourceResolution {
  const builder = BUILDERS[descriptor.kind];
  if (!builder) {
    return {
      ok: false,
      problem: {
        kind: descriptor.kind,
        reason: `no transcript source is registered for "${descriptor.kind}" (known: ${Object.keys(BUILDERS).sort().join(", ")})`,
      },
    };
  }

  const missing = builder.required.filter((key) => !descriptor.values[key]);
  if (missing.length > 0) {
    return {
      ok: false,
      problem: { kind: descriptor.kind, reason: `missing value(s): ${missing.join(", ")}` },
    };
  }

  try {
    return { ok: true, source: builder.build(descriptor.values) };
  } catch (err) {
    // A constructor that throws is a bug, but not one worth taking the
    // daemon's event loop down for -- capture stops, everything else runs.
    return { ok: false, problem: { kind: descriptor.kind, reason: err instanceof Error ? err.message : String(err) } };
  }
}
