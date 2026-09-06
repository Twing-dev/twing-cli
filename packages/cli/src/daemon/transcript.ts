/**
 * Session conversation capture, phase 1 (local only). Reads Claude Code's
 * own session transcript JSONL incrementally, keeps what
 * `@twing/core`'s `filterTranscriptEntry` says to keep, redacts it, and
 * appends it to `~/.twing/sessions/<sessionId>.jsonl`.
 *
 * Nothing here leaves the machine. Server storage and distillation are
 * deliberately deferred: capturing to local disk first lets the filter be
 * inspected against real output before anything is transmitted, while still
 * letting data accumulate from day one -- we can't distill what we never
 * captured.
 *
 * **Watermark, not end-of-session.** Every capture records the byte offset
 * it read up to (`<sessionId>.state.json`, beside the capture) and resumes
 * from there. Anchoring on `SessionEnd` alone would have lost the session
 * this was built against entirely: it ran 11 days across three repos and
 * produced zero commits. Its `SessionEnd` message is a last drain, never
 * the mechanism.
 *
 * **Storage is machine-local**, under `~/.twing/` with the socket, the
 * launch marker and the gate overrides -- never inside a repo working tree,
 * so no `.gitignore` entry is needed and no capture can be committed by
 * accident.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { captureEnabled, filterTranscriptEntry, findRepoRoot, loadManifestFromFile, twingConfigPath, type CapturedRecord } from "@twing/core";
import { redact } from "./redact.js";

/** Read the transcript delta in bounded chunks rather than one big buffer:
 * the first capture of an already-long session can be tens of MB, and a
 * daemon serving every repo on the machine has no business holding that in
 * memory at once. */
const READ_CHUNK_BYTES = 4 * 1024 * 1024;

export function defaultSessionsDir(): string {
  return path.join(os.homedir(), ".twing", "sessions");
}

export interface CaptureInput {
  sessionId: string;
  /** Absolute path to the transcript JSONL, as forwarded by the hook.
   * Absent from an older hook binary -- treated as "nothing to capture". */
  transcriptPath?: string;
  /** The session's cwd, used to find the repo whose `.twing/twing.yml`
   * governs capture. Absent/unresolvable means no repo opted out, which is
   * the same as enabled (see `CaptureConfig`). */
  cwd?: string;
  /** Overridable for tests; production always uses `defaultSessionsDir()`. */
  sessionsDir?: string;
}

export interface CaptureResult {
  /** Why nothing was captured, when nothing was. */
  skipped?: "no-transcript-path" | "transcript-missing" | "disabled" | "nothing-new";
  turnsWritten: number;
  pathsWritten: number;
  /** Byte offset now recorded as read. */
  offset: number;
}

interface CaptureState {
  transcriptPath: string;
  /** Bytes of the transcript already captured. */
  offset: number;
  /** Every file path already emitted for this session, so a `paths` record
   * only ever carries what's genuinely new. */
  paths: string[];
  updatedAt: string;
}

/** One capture at a time per session. `UserPromptSubmit` and `SessionEnd`
 * can land close enough together to overlap, and two concurrent passes over
 * the same watermark would double-write every turn between them. */
const inFlight = new Map<string, Promise<CaptureResult>>();

export function captureSession(input: CaptureInput): Promise<CaptureResult> {
  const previous = inFlight.get(input.sessionId) ?? Promise.resolve();
  const next = previous.then(
    () => runCapture(input),
    () => runCapture(input),
  );
  inFlight.set(input.sessionId, next);
  void next.finally(() => {
    if (inFlight.get(input.sessionId) === next) inFlight.delete(input.sessionId);
  });
  return next;
}

async function runCapture(input: CaptureInput): Promise<CaptureResult> {
  const empty = (skipped: CaptureResult["skipped"], offset = 0): CaptureResult => ({ skipped, turnsWritten: 0, pathsWritten: 0, offset });

  if (!input.transcriptPath) return empty("no-transcript-path");
  if (!captureAllowed(input.cwd)) return empty("disabled");

  let stat: fs.Stats;
  try {
    stat = await fsp.stat(input.transcriptPath);
  } catch {
    // The transcript can legitimately be gone (a deleted session, a path
    // from another machine in a synced home directory). Not an error.
    return empty("transcript-missing");
  }

  const sessionsDir = input.sessionsDir ?? defaultSessionsDir();
  await fsp.mkdir(sessionsDir, { recursive: true });

  const statePath = path.join(sessionsDir, `${input.sessionId}.state.json`);
  const capturePath = path.join(sessionsDir, `${input.sessionId}.jsonl`);
  const state = await readState(statePath, input.transcriptPath);

  // A transcript that shrank, or a session id now pointing at a different
  // file, means the offset describes bytes that no longer exist -- start
  // over rather than reading from the middle of a line.
  let offset = state.transcriptPath === input.transcriptPath ? state.offset : 0;
  if (offset > stat.size) offset = 0;
  if (offset === stat.size) return empty("nothing-new", offset);

  const seenPaths = new Set(state.paths);
  const records: CapturedRecord[] = [];
  const newPaths: string[] = [];

  const readTo = await forEachNewLine(input.transcriptPath, offset, stat.size, (line) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // a torn or malformed line is skipped, never fatal
    }
    const filtered = filterTranscriptEntry(parsed);
    for (const p of filtered.paths) {
      if (seenPaths.has(p)) continue;
      seenPaths.add(p);
      newPaths.push(p);
    }
    if (filtered.turn) {
      records.push({ type: "turn", role: filtered.turn.role, ts: filtered.turn.ts, text: redact(filtered.turn.text) });
    }
  });

  if (newPaths.length > 0) {
    // Paths are batched into one record per capture pass rather than one
    // per tool call: they cost well under 1% of a transcript in total, and
    // they're the only signal answering "which repos did this session
    // touch" -- but only if they aren't repeated thousands of times.
    records.push({ type: "paths", ts: new Date().toISOString(), paths: newPaths.map(redact) });
  }

  if (records.length > 0) {
    const header = fs.existsSync(capturePath)
      ? ""
      : JSON.stringify({ type: "session", sessionId: input.sessionId, transcriptPath: input.transcriptPath, capturedFrom: new Date().toISOString() }) + "\n";
    await fsp.appendFile(capturePath, header + records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  }

  await writeState(statePath, {
    transcriptPath: input.transcriptPath,
    offset: readTo,
    paths: [...seenPaths],
    updatedAt: new Date().toISOString(),
  });

  return {
    turnsWritten: records.filter((r) => r.type === "turn").length,
    pathsWritten: newPaths.length,
    offset: readTo,
  };
}

/**
 * The repo-level `capture:` switch, which is the *only* thing that turns
 * capture on (see `CaptureConfig`: opt-in). Resolved fresh from the
 * manifest on disk each pass -- the same thing `claims.ts` does rather than
 * trusting anything the daemon happens to have cached, since a read-only
 * session never registers a project with the `Syncer` at all.
 *
 * Both "no cwd" and "not a repo" resolve to *not* capturing: consent comes
 * from a committed file somebody deliberately edited, so the absence of
 * that file can never stand in for it.
 *
 * **Known gap, multi-repo sessions.** `cwd` here is the session's root, not
 * the repo of any individual turn -- one session can span several repos
 * (the transcript this was built against spanned three), and this decides
 * for the whole session from the root repo's manifest alone. So a session
 * rooted in an opted-in repo captures its turns about sibling repos that
 * never opted in. Bounded today because nothing leaves the machine; it has
 * to be settled before phase 2 transmits anything, and it is the same
 * question as the plan's open multi-repo attribution decision.
 */
function captureAllowed(cwd: string | undefined): boolean {
  if (!cwd) return false;
  try {
    return captureEnabled(loadManifestFromFile(twingConfigPath(findRepoRoot(cwd))));
  } catch {
    // Not a repo, or an unreadable manifest -- nothing opted in.
    return false;
  }
}

/**
 * Streams `[from, to)` of a file, handing each complete line to `onLine`,
 * and returns the offset of the last line terminator seen. A trailing
 * partial line -- normal, since Claude Code is appending to this file while
 * we read it -- is deliberately left outside the returned watermark, so the
 * next pass picks it up whole instead of splitting a JSON object in two.
 */
async function forEachNewLine(filePath: string, from: number, to: number, onLine: (line: string) => void): Promise<number> {
  const handle = await fsp.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(READ_CHUNK_BYTES);
    let position = from;
    let consumed = from;
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
        if (line.length > 0) onLine(line);
      }
      carry = Buffer.from(chunk.subarray(lastBreak + 1));
      consumed = position - carry.length;
    }

    return consumed;
  } finally {
    await handle.close();
  }
}

async function readState(statePath: string, transcriptPath: string): Promise<CaptureState> {
  try {
    const parsed = JSON.parse(await fsp.readFile(statePath, "utf8")) as Partial<CaptureState>;
    return {
      transcriptPath: typeof parsed.transcriptPath === "string" ? parsed.transcriptPath : transcriptPath,
      offset: typeof parsed.offset === "number" && parsed.offset >= 0 ? parsed.offset : 0,
      paths: Array.isArray(parsed.paths) ? parsed.paths.filter((p): p is string => typeof p === "string") : [],
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
    };
  } catch {
    // No state yet (first capture for this session), or a corrupt one.
    // Both mean "start from the beginning"; for the corrupt case that
    // re-appends turns already captured, which is the right trade against
    // the alternative (guessing an offset, and silently losing whatever
    // sits before the guess). `writeState` is write-then-rename precisely
    // so this stays the rare path.
    return { transcriptPath, offset: 0, paths: [], updatedAt: "" };
  }
}

async function writeState(statePath: string, state: CaptureState): Promise<void> {
  // Write-then-rename: a daemon killed mid-write must not leave a truncated
  // state file, which would silently reset the watermark to 0 and re-append
  // the whole session on the next pass.
  const tmp = `${statePath}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(state) + "\n", "utf8");
  await fsp.rename(tmp, statePath);
}
