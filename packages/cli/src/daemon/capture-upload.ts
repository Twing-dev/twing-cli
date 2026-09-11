/**
 * Ships captured sessions to their coordinator(s), on the same debounced,
 * never-blocking shape `sync.ts` uses for claims.
 *
 * **Reads the capture file, not the capture pass's return value.** The
 * obvious design -- hand the uploader the records `captureSession` just
 * wrote -- loses everything in flight if the daemon dies between the write
 * and the send. Instead this keeps its own byte watermark over
 * `~/.twing/sessions/<id>.jsonl` and resumes from it, so a crashed daemon,
 * an unreachable coordinator, or a 500 all end the same way: the bytes are
 * still on disk and the next pass sends them.
 *
 * That watermark lives in its own file rather than as another field on the
 * capture's `state.json`. Two writers on one file is a race, and the two
 * have genuinely independent lifecycles -- reading the transcript and
 * shipping the result fail for unrelated reasons and retry on unrelated
 * schedules.
 *
 * **Multi-coordinator.** A session can touch opted-in repos pointing at
 * different coordinators, and every one of them consented, so the capture
 * goes to each. The send watermark is therefore per (session, server), not
 * per session: one unreachable coordinator must not hold back another.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { authFetch, computeDeveloperId, getServerAuth, readConfig } from "@twing/core";
import { defaultSessionsDir, type CaptureTarget } from "./transcript.js";

/** Matches `sync.ts`'s flush cadence: often enough that a long session's
 * capture lands while it's still useful, rarely enough that a chatty
 * session isn't one request per turn. */
const UPLOAD_INTERVAL_MS = 7_000;

/** Bounded per request to stay under the server's own per-request cap
 * (`MAX_CAPTURE_RECORDS_PER_REQUEST`, app.ts) with room to spare. A backlog
 * larger than this drains over consecutive passes rather than in one
 * request. */
const MAX_RECORDS_PER_REQUEST = 2_000;

interface SessionTargets {
  /** Deduped by server: several opted-in repos can share one coordinator,
   * and the capture is one stream regardless of how many did. */
  byServer: Map<string, { projectIds: string[]; repoRoot: string }>;
}

interface SendWatermark {
  offset: number;
  updatedAt: string;
}

export class CaptureUploader {
  private readonly sessionsDir: string;
  private readonly sessions = new Map<string, SessionTargets>();
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(options: { sessionsDir?: string } = {}) {
    this.sessionsDir = options.sessionsDir ?? defaultSessionsDir();
  }

  /** Learns where a session's capture should go. Called after every capture
   * pass; re-registration is cheap and expected, and a session that gains a
   * second opted-in repo mid-flight simply gains a second destination. */
  register(sessionId: string, targets: CaptureTarget[]): void {
    if (targets.length === 0) return;
    const entry = this.sessions.get(sessionId) ?? { byServer: new Map() };
    for (const target of targets) {
      const existing = entry.byServer.get(target.serverUrl);
      if (existing) {
        if (!existing.projectIds.includes(target.projectId)) existing.projectIds.push(target.projectId);
      } else {
        entry.byServer.set(target.serverUrl, { projectIds: [target.projectId], repoRoot: target.repoRoot });
      }
    }
    this.sessions.set(sessionId, entry);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), UPLOAD_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Shutdown counterpart to `start()`, mirroring `Syncer.stopAndFlush` --
   * one last send on the way out so a session's final stretch isn't left
   * sitting on disk until the *next* daemon happens to pick the file back
   * up. `flush()` never throws (see its doc comment), so unlike the
   * Syncer's version this needs no try/catch of its own; the await is
   * what matters, so the process doesn't exit mid-request. */
  async stopAndFlush(): Promise<void> {
    this.stop();
    await this.flush();
  }

  /**
   * Sends whatever each registered session has gained since its last
   * successful send. Never throws: an upload failure is logged and the
   * watermark left where it was, so the same bytes are retried next pass.
   *
   * Guarded against overlap -- a slow coordinator must not have two flushes
   * reading the same watermark and sending the same records twice.
   */
  async flush(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const [sessionId, targets] of this.sessions) {
        for (const [serverUrl, target] of targets.byServer) {
          await this.flushOne(sessionId, serverUrl, target).catch((err) => {
            console.error(`twing daemon: capture upload failed for session ${sessionId} @ ${serverUrl}`, err);
          });
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async flushOne(sessionId: string, serverUrl: string, target: { projectIds: string[]; repoRoot: string }): Promise<void> {
    const capturePath = path.join(this.sessionsDir, `${sessionId}.jsonl`);
    if (!fs.existsSync(capturePath)) return;

    const watermarkPath = this.watermarkPath(sessionId, serverUrl);
    const watermark = await readWatermark(watermarkPath);
    const size = fs.statSync(capturePath).size;
    // A capture file only ever grows. A smaller size means it was replaced
    // (a session id reused against a new transcript), so start over rather
    // than reading from the middle of a line.
    let from = watermark.offset > size ? 0 : watermark.offset;
    if (from === size) return;

    const { records, readTo } = await readRecords(capturePath, from, size, MAX_RECORDS_PER_REQUEST);
    if (records.length === 0) return;

    const auth = getServerAuth(readConfig(), serverUrl);
    // A `--no-auth` coordinator wants a self-declared developer id instead
    // of a token; a missing header there is a hard 400, not an anonymous
    // write. Resolved from the repo that opted in, the same source the Go
    // hook uses on its own no-auth path.
    const developerId = auth?.noAuth ? computeDeveloperId(target.repoRoot) : undefined;

    const res = await authFetch(
      `${serverUrl}/v1/captures`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, records, projectIds: target.projectIds }),
      },
      auth?.authToken,
      developerId,
    );

    if (!res.ok) {
      // Deliberately does not advance: the same bytes go again next pass.
      // A capture is worth retrying indefinitely -- it is the only copy
      // outside the transcript, and the transcript is not ours to rely on.
      console.error(`twing daemon: capture upload rejected (${res.status}) for session ${sessionId} @ ${serverUrl}`);
      return;
    }

    await writeWatermark(watermarkPath, { offset: readTo, updatedAt: new Date().toISOString() });
  }

  /** One watermark per (session, server). The server is hashed into the
   * name rather than interpolated -- a URL carries `/` and `:`, neither of
   * which belongs in a filename. */
  private watermarkPath(sessionId: string, serverUrl: string): string {
    const suffix = Buffer.from(serverUrl).toString("base64url").slice(0, 32);
    return path.join(this.sessionsDir, `${sessionId}.sent-${suffix}.json`);
  }
}

/** Reads up to `limit` complete records starting at `from`, returning the
 * offset just past the last one. A trailing partial line -- the capture is
 * being appended to while this reads -- is left for the next pass. */
async function readRecords(
  capturePath: string,
  from: number,
  to: number,
  limit: number,
): Promise<{ records: Record<string, unknown>[]; readTo: number }> {
  const handle = await fsp.open(capturePath, "r");
  try {
    const length = to - from;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, from);

    const records: Record<string, unknown>[] = [];
    let readTo = from;
    let lineStart = 0;

    for (;;) {
      if (records.length >= limit) break;
      const breakAt = buffer.indexOf(0x0a, lineStart);
      if (breakAt === -1) break; // no complete line left
      const line = buffer.subarray(lineStart, breakAt).toString("utf8");
      lineStart = breakAt + 1;
      readTo = from + lineStart;
      if (line.length === 0) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) records.push(parsed as Record<string, unknown>);
      } catch {
        // A torn line is skipped rather than retried forever: the watermark
        // has already moved past it, which is the right trade against
        // wedging a session's uploads on one bad byte.
      }
    }

    return { records, readTo };
  } finally {
    await handle.close();
  }
}

async function readWatermark(watermarkPath: string): Promise<SendWatermark> {
  try {
    const parsed = JSON.parse(await fsp.readFile(watermarkPath, "utf8")) as Partial<SendWatermark>;
    return {
      offset: typeof parsed.offset === "number" && parsed.offset >= 0 ? parsed.offset : 0,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
    };
  } catch {
    // Never sent, or an unreadable watermark. Both mean "send from the
    // start"; the server appends, so the cost of the rare re-send is a
    // duplicated stretch, not a lost one.
    return { offset: 0, updatedAt: "" };
  }
}

async function writeWatermark(watermarkPath: string, watermark: SendWatermark): Promise<void> {
  // Write-then-rename, same reasoning as the capture's own state file: a
  // truncated watermark would reset to 0 and re-send the whole session.
  const tmp = `${watermarkPath}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(watermark) + "\n", "utf8");
  await fsp.rename(tmp, watermarkPath);
}
