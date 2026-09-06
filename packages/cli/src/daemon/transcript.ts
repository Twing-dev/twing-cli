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
import { captureEnabled, computeProjectId, filterTranscriptEntry, findRepoRoot, loadManifestFromFile, reposForEntry, twingConfigPath, type CapturedRecord, type RepoResolver } from "@twing/core";
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
  /** The session's cwd. Only a fast path now, not the decision: if the repo
   * it sits in has opted in, the whole session qualifies from its first
   * byte and no boundary needs finding. Otherwise consent is decided from
   * the repos the session actually *touched* -- see `findCaptureStart`.
   * Absent or outside any repo is not consent, and never was. */
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
  /** On the pass that turned capture on, the byte offset it reached back
   * to. Absent on every later pass. */
  startedFrom?: number;
}

interface CaptureState {
  transcriptPath: string;
  /** Bytes of the transcript already captured. */
  offset: number;
  /** Whether capture has turned on for this session. Sticky on purpose:
   * once any repo the session touched has opted in, the session is captured
   * for the rest of its life, including stretches that touch nothing or
   * touch repos that never opted in. A session is one working context and
   * its conversation is entangled across repos -- re-deciding per pass
   * would shred it, and the boundary that does matter (what precedes the
   * first opted-in touch) is settled once, by `findCaptureStart`. */
  enabled?: boolean;
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

  // Consent, decided once per session and then sticky. Until some repo the
  // session touched has opted in, nothing is captured *and the watermark is
  // never advanced* -- that is what leaves the earlier bytes available to
  // reach back over on the pass that finally turns capture on.
  const resolve = createRepoResolver();
  const isOptedIn = createOptedInCache();
  let startedFrom: number | undefined;

  if (!state.enabled) {
    const root = cwdRepo(input.cwd, resolve);
    if (root !== undefined && isOptedIn(root)) {
      // The session is rooted in a repo that opted in: no boundary to find,
      // the whole session qualifies from its first byte.
      startedFrom = 0;
    } else {
      startedFrom = await findCaptureStart(input.transcriptPath, stat.size, isOptedIn, resolve);
      if (startedFrom === undefined) return empty("disabled");
    }
    offset = startedFrom;
  }

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
    //
    // Resolved to projectIds here, on the only machine that can: see
    // `CapturedRecord`'s note. Absolute paths stay too -- they are what a
    // later fold routes on -- but they mean nothing to a server on their
    // own.
    const projectId = createProjectIdCache();
    const projects: string[] = [];
    for (const candidate of newPaths) {
      const root = resolve(candidate);
      if (root === undefined || !isOptedIn(root)) continue;
      const id = projectId(root);
      if (id !== undefined && !projects.includes(id)) projects.push(id);
    }
    records.push({
      type: "paths",
      ts: new Date().toISOString(),
      paths: newPaths.map(redact),
      ...(projects.length > 0 ? { projects } : {}),
    });
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
    enabled: true,
    paths: [...seenPaths],
    updatedAt: new Date().toISOString(),
  });

  return {
    turnsWritten: records.filter((r) => r.type === "turn").length,
    pathsWritten: newPaths.length,
    offset: readTo,
    ...(startedFrom !== undefined ? { startedFrom } : {}),
  };
}

/**
 * Whether one repository has opted in, via the `capture:` switch in its own
 * committed `.twing/twing.yml`. Opt-in is the whole model: the absence of
 * that file, or of the switch inside it, can never stand in for somebody
 * deliberately editing it.
 *
 * Memoized per capture pass rather than per daemon: a manifest edited
 * mid-session takes effect on the next pass, the same freshness `claims.ts`
 * gets by re-reading rather than trusting anything cached.
 */
function createOptedInCache(): (repoRoot: string) => boolean {
  const cache = new Map<string, boolean>();
  return (repoRoot: string): boolean => {
    const cached = cache.get(repoRoot);
    if (cached !== undefined) return cached;
    let enabled = false;
    try {
      enabled = captureEnabled(loadManifestFromFile(twingConfigPath(repoRoot)));
    } catch {
      enabled = false; // unreadable manifest: nothing opted in
    }
    cache.set(repoRoot, enabled);
    return enabled;
  };
}

/**
 * The twing `projectId` for a repo, memoized per capture pass.
 *
 * Memoized because `computeProjectId` shells out to `git remote get-url`:
 * once per distinct repo per pass is fine, once per path mention is not.
 *
 * Only ever called for repos that opted in. Beyond matching the consent
 * model, that keeps this away from its own side effect -- for a repo with
 * no remote, `computeProjectId` *writes* `.git/twing-project-id` -- so
 * merely observing a path in some unrelated checkout never leaves a mark
 * inside it.
 */
function createProjectIdCache(): (repoRoot: string) => string | undefined {
  const cache = new Map<string, string | undefined>();
  return (repoRoot: string): string | undefined => {
    if (cache.has(repoRoot)) return cache.get(repoRoot);
    let id: string | undefined;
    try {
      id = computeProjectId(repoRoot);
    } catch {
      id = undefined; // no git, no remote, unwritable .git -- attribution is best-effort
    }
    cache.set(repoRoot, id);
    return id;
  };
}

/** The repo containing the session's cwd, or undefined when cwd is absent
 * or isn't inside a repo at all. */
function cwdRepo(cwd: string | undefined, resolve: RepoResolver): string | undefined {
  if (!cwd) return undefined;
  return resolve(cwd);
}

/**
 * Where a retroactive capture may begin, or `undefined` when this session
 * has not touched an opted-in repo at all and must not be captured yet.
 *
 * Capture starts at the point the session first *touched* an opted-in repo
 * -- not at its first edit there. The first touch is a read, which is what
 * makes this retroactive enough to be worth doing: in the 42,117-line
 * transcript this was built against, twing-cli's first touch was line 117
 * and its first edit line 781, three hours of exploration later. Anchoring
 * on the edit would have thrown away the part worth keeping.
 *
 * From that point the walk runs backward and stops hard at the last entry
 * that touched a repo which has *not* opted in. That line is the consent
 * boundary: nothing before it concerned the repo whose manifest granted
 * permission, so it is a different unit of work and never leaves this
 * machine. Entries touching no repo at all -- discussion, a scratch file --
 * do not stop the walk, which is what lets the reasoning that preceded the
 * first read come along with it.
 *
 * Implemented as one forward pass rather than a scan-then-rewind: the stop
 * is simply the end of the most recent foreign-touch line seen before the
 * first opted-in touch.
 */
async function findCaptureStart(
  transcriptPath: string,
  size: number,
  isOptedIn: (repoRoot: string) => boolean,
  resolve: RepoResolver,
): Promise<number | undefined> {
  let start: number | undefined;
  let boundary = 0;

  await forEachNewLine(transcriptPath, 0, size, (line, lineStart) => {
    if (start !== undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    const repos = reposForEntry(filterTranscriptEntry(parsed), resolve);
    if (repos.length === 0) return; // touched no repo: neither a trigger nor a boundary

    // An entry touching an opted-in repo *and* a foreign one still counts
    // as the first opted-in touch: it is work in the consenting repo, and
    // stopping on it would put the boundary after the very line that
    // granted permission.
    if (repos.some(isOptedIn)) {
      start = boundary;
      return;
    }
    boundary = lineStart + Buffer.byteLength(line, "utf8") + 1;
  });

  return start;
}

/**
 * Streams `[from, to)` of a file, handing each complete line to `onLine`,
 * and returns the offset of the last line terminator seen. A trailing
 * partial line -- normal, since Claude Code is appending to this file while
 * we read it -- is deliberately left outside the returned watermark, so the
 * next pass picks it up whole instead of splitting a JSON object in two.
 */
async function forEachNewLine(filePath: string, from: number, to: number, onLine: (line: string, lineStart: number) => void): Promise<number> {
  const handle = await fsp.open(filePath, "r");
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
        if (line.length > 0) onLine(line, lineStart);
        // Advance past this line and its terminator. Byte length, not
        // string length: a line carrying any non-ASCII character occupies
        // more bytes than it has characters, and every offset downstream of
        // this is a file position.
        lineStart += Buffer.byteLength(line, "utf8") + 1;
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
      enabled: parsed.enabled === true,
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
    return { transcriptPath, offset: 0, enabled: false, paths: [], updatedAt: "" };
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

/**
 * A `RepoResolver` over the real filesystem, memoized per instance.
 *
 * Memoization is not an optimization here so much as a precondition: the
 * transcript this was built against names paths 42,117 times across a
 * handful of directories, and an unmemoized walk would stat the same
 * ancestors on every one of them, on the daemon's own event loop.
 *
 * The walk starts at the path itself rather than its parent, which handles
 * files and directories with one code path and no `stat`: for a file,
 * `<file>/.git` simply doesn't exist and the walk moves up as it would
 * anyway. Every directory visited on the way is backfilled with the answer,
 * so the second path under a repo resolves in one map lookup.
 *
 * Returns `undefined` rather than a fallback when nothing above the path is
 * a repo -- see `RepoResolver`'s doc comment in `@twing/core` for why that
 * distinction carries weight for capture consent.
 */
export function createRepoResolver(): RepoResolver {
  const cache = new Map<string, string | undefined>();

  return (absPath: string): string | undefined => {
    const visited: string[] = [];
    let dir = absPath;

    for (;;) {
      if (cache.has(dir)) {
        const hit = cache.get(dir);
        for (const seen of visited) cache.set(seen, hit);
        return hit;
      }
      visited.push(dir);

      if (fs.existsSync(path.join(dir, ".git"))) {
        for (const seen of visited) cache.set(seen, dir);
        return dir;
      }

      const parent = path.dirname(dir);
      if (parent === dir) {
        for (const seen of visited) cache.set(seen, undefined);
        return undefined;
      }
      dir = parent;
    }
  };
}
