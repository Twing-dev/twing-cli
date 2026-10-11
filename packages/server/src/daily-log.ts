/**
 * Date-rotated JSONL logs for the coordinator (2026-10-11): one file per
 * UTC day per kind -- `http-YYYY-MM-DD.jsonl` (every request/response) and
 * `llm-YYYY-MM-DD.jsonl` (every final prompt sent to the model and what came
 * back) -- under `/var/log/twing-cli/` (local and production alike), with
 * files older than the retention window swept away. Plain `node:fs`, no logging dependency.
 *
 * `httpLog`/`llmLog` are no-ops until `initLogging` runs (only `main.ts`
 * calls it), so tests and embedders that build `createApp` directly never
 * write anything to disk.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

const LOG_PREFIXES = ["http", "llm"] as const;
const FILE_RE = /^(http|llm)-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_RETENTION_DAYS = 7;
export const MAX_BODY_BYTES = 64 * 1024;
export const DEFAULT_LOG_DIR = "/var/log/twing-cli";

export class DailyLog {
  private stream: fs.WriteStream | undefined;
  private streamDate: string | undefined;
  private warned = false;

  constructor(
    private readonly dir: string,
    private readonly prefix: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  write(entry: object): void {
    try {
      const at = this.now();
      const date = at.toISOString().slice(0, 10);
      if (date !== this.streamDate) {
        this.stream?.end();
        fs.mkdirSync(this.dir, { recursive: true });
        this.stream = fs.createWriteStream(path.join(this.dir, `${this.prefix}-${date}.jsonl`), { flags: "a" });
        this.stream.on("error", (err) => this.warn(err));
        this.streamDate = date;
      }
      this.stream!.write(JSON.stringify({ ts: at.toISOString(), ...entry }) + "\n");
    } catch (err) {
      this.warn(err);
    }
  }

  /** Flushes and closes the current file -- tests only; the real server
   * keeps it open for the life of the process. */
  close(): Promise<void> {
    return new Promise((resolve) => (this.stream ? this.stream.end(resolve) : resolve()));
  }

  private warn(err: unknown): void {
    if (this.warned) return;
    this.warned = true;
    console.warn(`twing serve: ${this.prefix} log write failed, further failures suppressed: ${err instanceof Error ? err.message : err}`);
  }
}

/** Deletes `http-*`/`llm-*` files whose date (from the filename, not
 * mtime) is older than `retentionDays` before today. Returns what it
 * removed. Never throws. */
export function sweepOldLogs(dir: string, retentionDays: number, now: Date = new Date()): string[] {
  const removed: string[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return removed;
  }
  const today = Date.parse(now.toISOString().slice(0, 10));
  for (const name of names) {
    const match = FILE_RE.exec(name);
    if (!match) continue;
    if (today - Date.parse(match[2]!) < retentionDays * DAY_MS) continue;
    try {
      fs.unlinkSync(path.join(dir, name));
      removed.push(name);
    } catch {
      // Already gone or not ours to delete -- next sweep retries.
    }
  }
  return removed;
}

const SECRET_KEY_RE = /token|secret|password|authorization|cookie|private_?key/i;

/** Deep copy with the value of every secret-looking key replaced. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SECRET_KEY_RE.test(k) ? "[redacted]" : redact(v)]),
    );
  }
  return value;
}

export function capBody(text: string, max = MAX_BODY_BYTES): string {
  const bytes = Buffer.byteLength(text);
  if (bytes <= max) return text;
  return Buffer.from(text).subarray(0, max).toString() + `…[truncated ${bytes - max} bytes]`;
}

/** Whether a body of this type is worth reading as text (JSON, text,
 * form) rather than just sizing (uploads). */
export function isTextual(contentType: string | null | undefined): boolean {
  const type = contentType ?? "";
  return type.includes("json") || type.startsWith("text/") || type.includes("x-www-form-urlencoded");
}

/** What a request/response body looks like in the http log: parsed and
 * redacted JSON when it is JSON, capped text when it is text, and just a
 * size for anything binary (capture uploads). */
export function describeBody(contentType: string | null | undefined, text: string): unknown {
  if (text === "") return undefined;
  const type = contentType ?? "";
  if (type.includes("json")) {
    if (Buffer.byteLength(text) <= MAX_BODY_BYTES) {
      try {
        return redact(JSON.parse(text));
      } catch {
        // Fall through to capped text.
      }
    }
    return capBody(text);
  }
  if (type === "" || isTextual(type)) return capBody(text);
  return { contentType: type, bytes: Buffer.byteLength(text) };
}

const NOOP = { write: (_entry: object) => {} };
export let httpLog: Pick<DailyLog, "write"> = NOOP;
export let llmLog: Pick<DailyLog, "write"> = NOOP;

export function isLoggingEnabled(): boolean {
  return httpLog !== NOOP;
}

/** Carries the current HTTP request's id into anything it awaits, so an
 * LLM call made while serving a request can be joined to its http-log line.
 * Background work (resynthesis queue, async semantic check) runs outside
 * any request and logs without one. */
export const requestContext = new AsyncLocalStorage<{ requestId: string }>();

/** Turns logging on. Returns the directory in use, or `{ error }` when
 * disabled (`TWING_LOG_DISABLED=1`) or the directory isn't writable --
 * `/var/log` is root-owned, so a missing one-time `mkdir`/`chown` must not
 * stop the coordinator from serving. */
export function initLogging(): { dir: string; retentionDays: number } | { error: string } {
  if (process.env.TWING_LOG_DISABLED === "1") return { error: "disabled (TWING_LOG_DISABLED=1)" };
  const dir = process.env.TWING_LOG_DIR ?? DEFAULT_LOG_DIR;
  const parsed = Number(process.env.TWING_LOG_RETENTION_DAYS);
  const retentionDays = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RETENTION_DAYS;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (err) {
    return {
      error:
        `${dir} is not writable (${err instanceof Error ? err.message : err}). ` +
        `Run \`sudo mkdir -p ${dir} && sudo chown $USER ${dir}\` once, or set TWING_LOG_DIR`,
    };
  }
  httpLog = new DailyLog(dir, LOG_PREFIXES[0]);
  llmLog = new DailyLog(dir, LOG_PREFIXES[1]);
  sweepOldLogs(dir, retentionDays);
  setInterval(() => sweepOldLogs(dir, retentionDays), SWEEP_INTERVAL_MS).unref();
  return { dir, retentionDays };
}
