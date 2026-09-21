/**
 * Codex's conversation store, as a `TranscriptSource`.
 *
 * Codex keeps each session in a rollout file -- `$CODEX_HOME/sessions/
 * <yyyy>/<mm>/<dd>/rollout-<timestamp>-<session id>.jsonl` -- and hands its
 * hooks that path in `transcript_path` on every event, exactly as Claude Code
 * does. It is newline-delimited JSON, appended to while the session runs, so
 * the cheap part of `ClaudeCodeJsonlSource` applies unchanged: the cursor is
 * a byte offset, resuming is a seek, and "is there more" is a `stat`. This
 * source delegates all of that rather than re-deriving it.
 *
 * What it does own is the dialect. A rollout line is
 * `{timestamp, ordinal, type, payload}` where `type` is one of a dozen
 * bookkeeping kinds, and the conversation lives inside the `response_item`
 * ones in OpenAI Responses shape (`message`/`function_call`/
 * `custom_tool_call`), not Claude Code's. `filterTranscriptEntry`
 * (`@twing/core`) reads Claude Code's shape and only that -- deliberately, so
 * the consent boundary, the redaction and the capture file stay one
 * implementation -- so the translation happens here, the same way
 * `opencode-sqlite-source.ts` translates OpenCode's rows.
 *
 * **What is dropped, and why it is dropped *here*.** Codex injects several
 * of its own turns as `role: "user"` messages -- the environment context
 * block, the user's `AGENTS.md`, the skills preamble, and any
 * `additionalContext` a hook (twing's own included) returned. By role alone
 * they are indistinguishable from something a human typed, which is the exact
 * failure `transcript-filter.ts` exists to prevent on the Claude side. They
 * are marked `isMeta` in translation, which is Claude Code's own marker for
 * "a turn the harness injected", so the core filter drops their text while
 * still keeping any path they name.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { patchPaths } from "../opencode-adapter.js";
import {
  ClaudeCodeJsonlSource,
  registerTranscriptSource,
  type Cursor,
  type TranscriptEntry,
  type TranscriptSource,
} from "./transcript-source.js";

/** Rollout record kinds that carry conversation. Everything else --
 * `event_msg` (the UI's own duplicate of each item), `world_state`,
 * `token_usage_record`, `compacted`, and whatever Codex adds next -- is
 * bookkeeping. An allowlist of one, for the same reason `transcript-filter`
 * allows two entry types: new kinds stay out by construction. */
const CONVERSATION_KIND = "response_item";

/**
 * The wrappers Codex fills with its own text and sends as a `role: "user"`
 * message -- the environment block, the repo's `AGENTS.md`, the skills and
 * plugin preambles, the plugin marketplace listing.
 *
 * Stripped wherever they appear rather than matched at the start, and the
 * remainder kept: exactly what `transcript-filter.ts` does with Claude Code's
 * `<system-reminder>`, and for the same reason. Codex 0.155 sends several of
 * these concatenated into *one* message, with the human's own prompt arriving
 * separately -- so a start-anchored test passes the whole blob through as a
 * human turn the moment a new wrapper is prepended to the list. Found exactly
 * that way, against a real 0.155 session: `<recommended_plugins>` was new, and
 * a 1.4KB plugin catalogue landed in the capture as something a person typed.
 *
 * A turn left empty after stripping is marked `isMeta` -- Claude Code's own
 * marker for a turn the harness injected -- so the core filter drops its text
 * while still keeping any path it named.
 */
const INJECTED_BLOCK = /<(environment_context|user_instructions|skills_instructions|plugin_instructions|apps_instructions|recommended_plugins|user_shell|agents_md)>[\s\S]*?<\/\1>/g;

interface RolloutLine {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

/**
 * Codex's rollout JSONL. Cursor, existence and chunked reading come from
 * `ClaudeCodeJsonlSource`; every line that comes back is translated before
 * the caller sees it.
 */
export class CodexRolloutSource implements TranscriptSource {
  readonly kind = "codex-rollout";
  readonly beginning: Cursor;

  private readonly jsonl: ClaudeCodeJsonlSource;
  /** The session's working directory, learned from the file's own first
   * line. Cached because it is read per pass and never changes. */
  private sessionCwd: string | undefined;
  private sessionCwdLoaded = false;

  constructor(private readonly filePath: string) {
    this.jsonl = new ClaudeCodeJsonlSource(filePath);
    this.beginning = this.jsonl.beginning;
  }

  exists(): Promise<boolean> {
    return this.jsonl.exists();
  }

  resume(stored: string | undefined): Promise<Cursor> {
    return this.jsonl.resume(stored);
  }

  atEnd(cursor: Cursor): Promise<boolean> {
    return this.jsonl.atEnd(cursor);
  }

  async read(cursor: Cursor, onEntry: (entry: TranscriptEntry) => void): Promise<Cursor> {
    // Read before streaming, not while: a pass that resumes mid-file never
    // reaches the header line, and without a cwd every relative path a patch
    // names resolves to no repo at all -- which reads as "this session
    // touched nothing" and silently captures nothing.
    let cwd = await this.loadSessionCwd();

    return this.jsonl.read(cursor, (entry) => {
      const line = entry.value as RolloutLine | null;
      if (!line || typeof line !== "object") return;

      // A turn can move the working directory (`codex --cd`, a resumed
      // session), and the record that says so precedes the turns it applies
      // to.
      const declared = declaredCwd(line);
      if (declared) cwd = declared;

      if (line.type !== CONVERSATION_KIND) return;
      const translated = translateRolloutItem(line, cwd);
      if (translated) onEntry({ value: translated, after: entry.after });
    });
  }

  /** The `session_meta` header's `cwd`, or undefined if the file is gone or
   * does not start with one. Reads only the first line. */
  private async loadSessionCwd(): Promise<string | undefined> {
    if (this.sessionCwdLoaded) return this.sessionCwd;
    this.sessionCwdLoaded = true;
    try {
      const handle = await fsp.open(this.filePath, "r");
      try {
        const buffer = Buffer.alloc(64 * 1024);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0];
        this.sessionCwd = declaredCwd(JSON.parse(firstLine) as RolloutLine);
      } finally {
        await handle.close();
      }
    } catch {
      // Missing, unreadable, or a first line longer than the buffer: every
      // one of them means "no cwd known", which costs relative paths their
      // repo and nothing else.
      this.sessionCwd = undefined;
    }
    return this.sessionCwd;
  }
}

/** The working directory a `session_meta`/`turn_context` record declares. */
function declaredCwd(line: RolloutLine): string | undefined {
  if (line.type !== "session_meta" && line.type !== "turn_context") return undefined;
  const cwd = line.payload?.cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : undefined;
}

interface ResponseItem {
  type?: string;
  role?: string;
  content?: unknown;
  name?: unknown;
  arguments?: unknown;
  input?: unknown;
}

/**
 * One rollout `response_item` in the entry shape `filterTranscriptEntry`
 * reads, or undefined for the items that carry no conversation at all.
 *
 * Dropped outright: `reasoning` (the model's private chain of thought -- the
 * Claude side drops thinking blocks by the same construction), and every
 * `*_output` item (tool results, dropped whole on every harness).
 */
export function translateRolloutItem(line: RolloutLine, cwd: string | undefined): unknown | undefined {
  const payload = line.payload as ResponseItem | undefined;
  if (!payload || typeof payload !== "object") return undefined;

  const timestamp = typeof line.timestamp === "string" ? line.timestamp : undefined;
  const base = {
    ...(timestamp ? { timestamp } : {}),
    ...(cwd ? { cwd } : {}),
  };

  if (payload.type === "message") {
    // `developer` is Codex's channel for harness-authored instructions --
    // never a human turn, and where hook `additionalContext` lands.
    const role = payload.role === "assistant" ? "assistant" : "user";
    const raw = messageText(payload.content);
    const text = role === "user" ? raw.replace(INJECTED_BLOCK, "").trim() : raw;
    const injected = payload.role === "developer" || text.length === 0;
    return {
      type: role,
      ...base,
      ...(injected ? { isMeta: true } : {}),
      message: { role, content: [{ type: "text", text }] },
    };
  }

  // Both tool-call shapes: `function_call` for a JSON-argument tool,
  // `custom_tool_call` for a freeform one (which is how Codex's own
  // `apply_patch` arrives). Only the paths they name survive -- the same
  // contract a Claude `tool_use` block gets.
  if (payload.type === "function_call" || payload.type === "custom_tool_call") {
    const named = toolCallPaths(payload);
    if (named.length === 0) return undefined;
    // Absolute, resolved here against the session's directory. A Codex patch
    // names its files relative to that directory, and the capture pipeline
    // resolves a relative path in two places -- `reposForEntry`, which uses
    // the entry's cwd and is right, and `transcript.ts`'s projectId pass,
    // which has only the bare path and so resolves it against the *daemon's*
    // cwd. That daemon serves every repo on the machine: found live, a Codex
    // session in one repo was labelled with the projectId of whatever repo
    // the daemon happened to be started in. Claude Code never exposed it
    // because its tool inputs are already absolute.
    const absolute = named.map((named) => (cwd && !path.isAbsolute(named) ? path.resolve(cwd, named) : named));
    return {
      type: "assistant",
      ...base,
      message: { role: "assistant", content: absolute.map((file) => ({ type: "tool_use", input: { file_path: file } })) },
    };
  }

  return undefined;
}

/** The text of a Responses-shaped message, across the input/output spellings
 * of a content block. */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const text = (block as { text?: unknown }).text;
    if (typeof text === "string" && text.length > 0) parts.push(text);
  }
  return parts.join("\n");
}

/**
 * Every file path one Codex tool call names.
 *
 * `apply_patch` carries its targets inside the patch text rather than in a
 * field, so the patch is parsed -- and it has to be, because it is the *only*
 * way a Codex session names a file it edited. (Reads and searches happen
 * inside Codex's shell tool, whose `command` is deliberately not mined for
 * paths, on the same reasoning that keeps twing out of Claude's Bash and
 * OpenCode's bash: guessing at arbitrary shell text would smuggle tool
 * content back in through the one field the contract says is kept.) The patch
 * parser is `opencode-adapter.ts`'s, which already reads exactly this format
 * for OpenCode's `apply_patch` -- one parser, two harnesses.
 *
 * Any other tool's arguments are scanned for the path-shaped keys the core
 * filter already recognises, which is what picks up `view_image`'s `path`.
 */
function toolCallPaths(payload: ResponseItem): string[] {
  const name = typeof payload.name === "string" ? payload.name.toLowerCase() : "";
  const freeform = typeof payload.input === "string" ? payload.input : "";

  if (name === "apply_patch" || name === "patch" || freeform.includes("*** Begin Patch")) {
    const raw = freeform || stringArgument(payload.arguments, ["input", "patch", "command"]);
    return raw ? patchPaths(patchEnvelope(raw)) : [];
  }

  const args = parseArguments(payload.arguments);
  const paths: string[] = [];
  for (const key of ["file_path", "path", "notebook_path"]) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) paths.push(value);
  }
  return paths;
}

/**
 * The patch envelope, with real newlines.
 *
 * Codex's newer models run in **code mode** (`tool_mode: "code_mode_only"`,
 * the default for gpt-6-astra on 0.155): instead of one tool call per action,
 * the model writes JavaScript, and the rollout records that source --
 * `text(await tools.apply_patch("*** Begin Patch\n*** Update File: ..."))`.
 * The patch is all there, but as a *string literal*, so its newlines are two
 * characters and the whole envelope is one physical line. A line-oriented
 * parser then finds no headers at all, which is not a parse failure, just
 * silence: found live, on a real 0.155 session whose edit went completely
 * unattributed and so never triggered capture consent.
 *
 * Unescaped only when the raw text has no real header line, so a normal patch
 * is never rewritten -- a `\n` inside an added line of source stays exactly
 * as the model wrote it.
 */
function patchEnvelope(raw: string): string {
  if (/^\s*\*\*\* (?:Add|Update|Delete|Move to)/m.test(raw)) return raw;
  return raw.replace(/\\r\\n|\\n/g, "\n");
}

function parseArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function stringArgument(raw: unknown, keys: string[]): string {
  const args = parseArguments(raw);
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

registerTranscriptSource("codex-rollout", ["path"], (values) => new CodexRolloutSource(values.path));
