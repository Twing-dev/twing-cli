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
 * **Watermark, not end-of-session.** Every capture records the position it
 * read up to (`<sessionId>.state.json`, beside the capture) and resumes
 * from there. Anchoring on `SessionEnd` alone would have lost the session
 * this was built against entirely: it ran 11 days across three repos and
 * produced zero commits. Its `SessionEnd` message is a last drain, never
 * the mechanism.
 *
 * That position is an opaque `Cursor` owned by a `TranscriptSource`
 * (`transcript-source.ts`), not a byte offset. Everything in this file is
 * harness-neutral -- consent, reach-back, filtering, redaction, the capture
 * file, upload targets -- and reading the raw conversation is the one part
 * that is not, so it lives behind that interface. Nothing here may parse a
 * cursor or compare two.
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
import { captureEnabled, computeProjectId, filterTranscriptEntry, findRepoRoot, loadManifestFromFile, reposForEntry, twingConfigPath, type CapturedRecord, type RepoResolver, type TranscriptSourceDescriptor } from "@twing/core";
import { redact } from "./redact.js";
import { resolveTranscriptSource, type Cursor, type TranscriptSource } from "./transcript-source.js";
// Imported for its side effect: registering `opencode-sqlite` in the source
// registry. Without this the descriptor an OpenCode session sends resolves to
// "no transcript source is registered", which is at least a loud failure --
// but the whole point of this wiring is that it not fail at all.
import "./opencode-sqlite-source.js";

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
  /** Where to read the raw conversation from, as the harness described it.
   * Resolved through `resolveTranscriptSource`'s registry, so this file
   * never grows a harness switch -- adding a harness adds a registry entry
   * and touches nothing here. When absent, a `transcriptPath` is treated as
   * a `claude-code-jsonl` descriptor, which is what an older hook binary
   * that predates the descriptor meant by sending one. */
  sourceDescriptor?: TranscriptSourceDescriptor;
  /** A ready-made source, for tests that want to drive capture without a
   * registry entry or a real transcript. Wins over `sourceDescriptor`. */
  source?: TranscriptSource;
}

/**
 * A stable name for "the thing this cursor is a position in".
 *
 * The stored watermark is only meaningful against the source it came from, so
 * a session id that starts pointing somewhere else has to reset rather than
 * resume at a byte offset into a different file. For Claude Code that identity
 * was the transcript path, and this deliberately still *is* that path for
 * `claude-code-jsonl`, so every state file written before descriptors existed
 * keeps matching and no session re-captures itself on upgrade.
 */
export function sourceIdentity(descriptor: TranscriptSourceDescriptor): string {
  if (descriptor.kind === "claude-code-jsonl") return descriptor.values.path ?? "";
  const values = Object.keys(descriptor.values)
    .sort()
    .map((key) => `${key}=${descriptor.values[key]}`)
    .join("&");
  return `${descriptor.kind}:${values}`;
}

/**
 * One opted-in repo this session touched that has a coordinator configured
 * -- everything the uploader needs to send the capture somewhere, resolved
 * here because only this side can resolve any of it: the repo root comes
 * from walking the filesystem, the projectId from that repo's git remote,
 * and the coordinator from its committed manifest.
 */
export interface CaptureTarget {
  repoRoot: string;
  projectId: string;
  serverUrl: string;
}

export interface CaptureResult {
  /** Why nothing was captured, when nothing was. */
  skipped?: "no-transcript-path" | "transcript-missing" | "disabled" | "nothing-new" | "unresolved-source";
  /** Why the source could not be built, when `skipped` is
   * `"unresolved-source"`. Carried out rather than swallowed so the daemon
   * can log it: a capture that silently does nothing is the failure mode
   * this whole path keeps producing. */
  problem?: string;
  turnsWritten: number;
  pathsWritten: number;
  /** Position now recorded as read. Opaque -- see `Cursor`. */
  cursor: Cursor;
  /**
   * On the pass that turned capture on, how far back it reached. Absent on
   * every later pass, which is how a caller tells the enabling pass from
   * the rest.
   *
   * A discriminator rather than the position itself: the only question
   * anyone actually asks of it is "did the whole session qualify, or did we
   * stop at a boundary", and a cursor cannot answer that without being
   * parsed -- which no caller is allowed to do.
   */
  reachedBack?: "session-start" | "consent-boundary";
  /** Where this session's capture may be uploaded, across every opted-in
   * repo it has touched so far -- not only the ones touched this pass, so a
   * pass that adds no new paths still reports the full set. Empty when the
   * opted-in repos have no coordinator configured, which is a perfectly
   * ordinary local-only capture. */
  targets: CaptureTarget[];
}

interface CaptureState {
  /** What the cursor is a position *in* -- see `sourceIdentity`. Written as
   * `sourceId`; a state file from before harnesses other than Claude Code
   * existed carries the equivalent value under `transcriptPath`, which
   * `readState` still accepts. */
  sourceId: string;
  /** How far into the transcript this session has already been captured, as
   * the source's own opaque cursor. Written as `cursor`; a state file from
   * before this seam existed carries a numeric `offset` instead, which
   * `readState` still accepts -- see its own note. */
  cursor?: Cursor;
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
  const empty = (skipped: CaptureResult["skipped"], cursor: Cursor = ""): CaptureResult => ({ skipped, turnsWritten: 0, pathsWritten: 0, cursor, targets: [] });

  // An older hook binary sends only a path, and means Claude Code by it.
  const descriptor: TranscriptSourceDescriptor | undefined = input.sourceDescriptor
    ?? (input.transcriptPath ? { kind: "claude-code-jsonl", values: { path: input.transcriptPath } } : undefined);
  if (!input.source && !descriptor) return empty("no-transcript-path");

  let source: TranscriptSource;
  if (input.source) {
    source = input.source;
  } else {
    const resolved = resolveTranscriptSource(descriptor!);
    if (!resolved.ok) {
      // Reported, never swallowed. This is the branch that would otherwise
      // produce a system that looks entirely healthy and captures nothing.
      return { ...empty("unresolved-source"), problem: `${resolved.problem.kind}: ${resolved.problem.reason}` };
    }
    source = resolved.source;
  }

  const identity = descriptor ? sourceIdentity(descriptor) : (input.transcriptPath ?? "");
  if (!(await source.exists())) {
    // The transcript can legitimately be gone (a deleted session, a path
    // from another machine in a synced home directory). Not an error.
    return empty("transcript-missing");
  }

  const sessionsDir = input.sessionsDir ?? defaultSessionsDir();
  await fsp.mkdir(sessionsDir, { recursive: true });

  const statePath = path.join(sessionsDir, `${input.sessionId}.state.json`);
  const capturePath = path.join(sessionsDir, `${input.sessionId}.jsonl`);
  const state = await readState(statePath, identity);

  // A session id now pointing at a different source makes the stored cursor
  // describe something else entirely; the source handles the rest of that
  // family (a file that shrank or rotated) inside `resume`.
  let cursor = await source.resume(state.sourceId === identity ? state.cursor : undefined);

  // Consent, decided once per session and then sticky. Until some repo the
  // session touched has opted in, nothing is captured *and the watermark is
  // never advanced* -- that is what leaves the earlier bytes available to
  // reach back over on the pass that finally turns capture on.
  const resolve = createRepoResolver();
  const isOptedIn = createOptedInCache();
  const projectId = createProjectIdCache();
  const coordinator = createCoordinatorCache();
  let reachedBack: CaptureResult["reachedBack"];

  if (!state.enabled) {
    const root = cwdRepo(input.cwd, resolve);
    if (root !== undefined && isOptedIn(root)) {
      // The session is rooted in a repo that opted in: no boundary to find,
      // the whole session qualifies from its first entry.
      cursor = source.beginning;
      reachedBack = "session-start";
    } else {
      const start = await findCaptureStart(source, isOptedIn, resolve);
      if (start === undefined) return empty("disabled");
      cursor = start;
      reachedBack = start === source.beginning ? "session-start" : "consent-boundary";
    }
  }

  if (await source.atEnd(cursor)) return empty("nothing-new", cursor);

  const seenPaths = new Set(state.paths);
  const records: CapturedRecord[] = [];
  const newPaths: string[] = [];

  const readTo = await source.read(cursor, ({ value }) => {
    const filtered = filterTranscriptEntry(value);
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
      : JSON.stringify({ type: "session", sessionId: input.sessionId, source: descriptor?.kind ?? "claude-code-jsonl", sourceId: identity, capturedFrom: new Date().toISOString() }) + "\n";
    await fsp.appendFile(capturePath, header + records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  }

  // Session-level, over every path seen so far rather than only this pass's
  // new ones: a pass that captures turns but names no new file must still
  // report where the capture goes, or an upload would stall waiting for a
  // path that may never come.
  const targets: CaptureTarget[] = [];
  for (const candidate of seenPaths) {
    const root = resolve(candidate);
    if (root === undefined || !isOptedIn(root)) continue;
    if (targets.some((t) => t.repoRoot === root)) continue;
    const serverUrl = coordinator(root);
    const id = projectId(root);
    if (serverUrl === undefined || id === undefined) continue;
    targets.push({ repoRoot: root, projectId: id, serverUrl });
  }

  await writeState(statePath, {
    sourceId: identity,
    cursor: readTo,
    enabled: true,
    paths: [...seenPaths],
    updatedAt: new Date().toISOString(),
  });

  return {
    turnsWritten: records.filter((r) => r.type === "turn").length,
    pathsWritten: newPaths.length,
    cursor: readTo,
    targets,
    ...(reachedBack !== undefined ? { reachedBack } : {}),
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

/** A repo's configured coordinator, memoized per pass. Absent is ordinary:
 * a repo can opt into capture without ever having run `twing init`, and its
 * capture simply stays on this machine. */
function createCoordinatorCache(): (repoRoot: string) => string | undefined {
  const cache = new Map<string, string | undefined>();
  return (repoRoot: string): string | undefined => {
    if (cache.has(repoRoot)) return cache.get(repoRoot);
    let url: string | undefined;
    try {
      url = loadManifestFromFile(twingConfigPath(repoRoot)).coordinator.serverUrl;
    } catch {
      url = undefined;
    }
    cache.set(repoRoot, url);
    return url;
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
  source: TranscriptSource,
  isOptedIn: (repoRoot: string) => boolean,
  resolve: RepoResolver,
): Promise<Cursor | undefined> {
  let start: Cursor | undefined;
  let boundary = source.beginning;

  await source.read(source.beginning, ({ value, after }) => {
    if (start !== undefined) return;
    const repos = reposForEntry(filterTranscriptEntry(value), resolve);
    if (repos.length === 0) return; // touched no repo: neither a trigger nor a boundary

    // An entry touching an opted-in repo *and* a foreign one still counts
    // as the first opted-in touch: it is work in the consenting repo, and
    // stopping on it would put the boundary after the very entry that
    // granted permission.
    if (repos.some(isOptedIn)) {
      start = boundary;
      return;
    }
    boundary = after;
  });

  return start;
}

/**
 * A state file written before the `TranscriptSource` seam existed holds
 * `{"offset": 22696087}` -- a bare number -- where this one writes
 * `{"cursor": "b:22696087"}`.
 *
 * Both are read, and the legacy field is handed to the source as a cursor
 * rather than being translated here: `ClaudeCodeJsonlSource` accepts a bare
 * number precisely so this file never has to know what a byte offset is.
 * Getting this wrong is silent, not loud -- an unread legacy watermark
 * re-captures the session from its first entry and re-uploads all of it, on
 * every machine with a session in flight at upgrade time.
 */
async function readState(statePath: string, sourceId: string): Promise<CaptureState> {
  try {
    const parsed = JSON.parse(await fsp.readFile(statePath, "utf8")) as Partial<CaptureState> & { offset?: unknown; transcriptPath?: unknown };
    const legacyOffset = typeof parsed.offset === "number" && Number.isSafeInteger(parsed.offset) && parsed.offset >= 0 ? String(parsed.offset) : undefined;
    // `sourceIdentity` returns the bare path for `claude-code-jsonl`, so a
    // legacy `transcriptPath` compares equal to the new identity without any
    // migration -- an in-flight session keeps its watermark across the
    // upgrade instead of re-capturing and re-uploading itself.
    const legacySourceId = typeof parsed.transcriptPath === "string" ? parsed.transcriptPath : undefined;
    return {
      sourceId: typeof parsed.sourceId === "string" ? parsed.sourceId : (legacySourceId ?? sourceId),
      cursor: typeof parsed.cursor === "string" ? parsed.cursor : legacyOffset,
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
    return { sourceId, cursor: undefined, enabled: false, paths: [], updatedAt: "" };
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
