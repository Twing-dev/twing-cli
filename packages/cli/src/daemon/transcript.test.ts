/**
 * Watermark behavior for session conversation capture: an append is picked
 * up from where the last pass stopped, and nothing is captured twice.
 *
 * The watermark is the reason capture is anchored on the session rather
 * than on a commit or a `SessionEnd`. The session this feature was built
 * against ran 11 days across three repos and produced zero commits; an
 * end-anchored capture would have kept none of it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { captureSession, createRepoResolver } from "./transcript.js";

/** A scratch dir that is also an opted-in repo: capture is opt-in, so
 * every test that expects anything to be captured has to pass a `cwd`
 * whose manifest says `capture: {enabled: true}`. */
function scratch(): { dir: string; transcript: string; sessionsDir: string; cwd: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twing-capture-test-"));
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".twing"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".twing", "twing.yml"), "capture:\n  enabled: true\n");
  return { dir, transcript: path.join(dir, "transcript.jsonl"), sessionsDir: path.join(dir, "sessions"), cwd: dir };
}

function humanTurn(text: string): string {
  return JSON.stringify({ type: "user", timestamp: "2026-09-05T12:00:00.000Z", message: { role: "user", content: text } }) + "\n";
}

function assistantTurn(text: string): string {
  return JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n";
}

function toolCall(filePath: string): string {
  return JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: { file_path: filePath } }] } }) + "\n";
}

function readCapture(sessionsDir: string, sessionId: string): Record<string, unknown>[] {
  const file = path.join(sessionsDir, `${sessionId}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

test("captureSession: captures human turns and assistant prose on a first pass", async () => {
  const { transcript, sessionsDir, cwd } = scratch();
  fs.writeFileSync(transcript, humanTurn("fix the watermark") + assistantTurn("Fixed."));

  const result = await captureSession({ sessionId: "s1", transcriptPath: transcript, cwd, sessionsDir });

  assert.equal(result.turnsWritten, 2);
  const records = readCapture(sessionsDir, "s1");
  assert.equal(records[0].type, "session", "the first record identifies the session");
  assert.deepEqual(
    records.filter((r) => r.type === "turn").map((r) => [r.role, r.text]),
    [
      ["user", "fix the watermark"],
      ["assistant", "Fixed."],
    ],
  );
});

test("captureSession: a second pass captures only what was appended since the first", async () => {
  const { transcript, sessionsDir, cwd } = scratch();
  fs.writeFileSync(transcript, humanTurn("first prompt"));
  const first = await captureSession({ sessionId: "s2", transcriptPath: transcript, cwd, sessionsDir });
  assert.equal(first.turnsWritten, 1);

  fs.appendFileSync(transcript, humanTurn("second prompt"));
  const second = await captureSession({ sessionId: "s2", transcriptPath: transcript, cwd, sessionsDir });

  assert.equal(second.turnsWritten, 1, "only the appended turn");
  const texts = readCapture(sessionsDir, "s2")
    .filter((r) => r.type === "turn")
    .map((r) => r.text);
  assert.deepEqual(texts, ["first prompt", "second prompt"], "no duplication across the two reads");
});

test("captureSession: nothing new since the last pass writes nothing at all", async () => {
  const { transcript, sessionsDir, cwd } = scratch();
  fs.writeFileSync(transcript, humanTurn("only prompt"));
  await captureSession({ sessionId: "s3", transcriptPath: transcript, cwd, sessionsDir });

  const again = await captureSession({ sessionId: "s3", transcriptPath: transcript, cwd, sessionsDir });

  assert.equal(again.skipped, "nothing-new");
  assert.equal(readCapture(sessionsDir, "s3").filter((r) => r.type === "turn").length, 1);
});

test("captureSession: a partial trailing line is left for the next pass, not captured torn", async () => {
  const { transcript, sessionsDir, cwd } = scratch();
  const complete = humanTurn("complete turn");
  // Claude Code is appending while we read: the tail is half a JSON object.
  const partial = humanTurn("partial turn").slice(0, 40);
  fs.writeFileSync(transcript, complete + partial);

  const first = await captureSession({ sessionId: "s4", transcriptPath: transcript, cwd, sessionsDir });
  assert.equal(first.turnsWritten, 1);
  assert.equal(first.offset, Buffer.byteLength(complete), "the watermark stops at the last complete line");

  // The rest of that line arrives; it must be captured whole exactly once.
  fs.appendFileSync(transcript, humanTurn("partial turn").slice(40));
  const second = await captureSession({ sessionId: "s4", transcriptPath: transcript, cwd, sessionsDir });

  assert.equal(second.turnsWritten, 1);
  const texts = readCapture(sessionsDir, "s4")
    .filter((r) => r.type === "turn")
    .map((r) => r.text);
  assert.deepEqual(texts, ["complete turn", "partial turn"]);
});

test("captureSession: a truncated/rotated transcript restarts from the beginning rather than reading mid-line", async () => {
  const { transcript, sessionsDir, cwd } = scratch();
  fs.writeFileSync(transcript, humanTurn("a long first prompt that makes the file big"));
  await captureSession({ sessionId: "s5", transcriptPath: transcript, cwd, sessionsDir });

  fs.writeFileSync(transcript, humanTurn("short"));
  const after = await captureSession({ sessionId: "s5", transcriptPath: transcript, cwd, sessionsDir });

  assert.equal(after.turnsWritten, 1);
  assert.equal(after.offset, Buffer.byteLength(humanTurn("short")));
});

test("captureSession: file paths are emitted once, deduped across passes", async () => {
  const { transcript, sessionsDir, cwd } = scratch();
  fs.writeFileSync(transcript, toolCall("/repo/src/a.ts") + toolCall("/repo/src/a.ts") + toolCall("/repo/src/b.ts"));
  const first = await captureSession({ sessionId: "s6", transcriptPath: transcript, cwd, sessionsDir });
  assert.equal(first.pathsWritten, 2);

  fs.appendFileSync(transcript, toolCall("/repo/src/a.ts") + toolCall("/repo/src/c.ts"));
  const second = await captureSession({ sessionId: "s6", transcriptPath: transcript, cwd, sessionsDir });

  assert.equal(second.pathsWritten, 1, "only the path never seen before");
  const paths = readCapture(sessionsDir, "s6")
    .filter((r) => r.type === "paths")
    .flatMap((r) => r.paths as string[]);
  assert.deepEqual(paths, ["/repo/src/a.ts", "/repo/src/b.ts", "/repo/src/c.ts"]);
});

test("captureSession: tool traffic alone produces no turns -- only the paths it named", async () => {
  const { transcript, sessionsDir, cwd } = scratch();
  fs.writeFileSync(transcript, toolCall("/repo/src/a.ts"));

  const result = await captureSession({ sessionId: "s7", transcriptPath: transcript, cwd, sessionsDir });

  assert.equal(result.turnsWritten, 0);
  assert.equal(result.pathsWritten, 1);
});

test("captureSession: captured text is redacted", async () => {
  const { transcript, sessionsDir, cwd } = scratch();
  fs.writeFileSync(transcript, humanTurn("use ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 to authenticate"));

  await captureSession({ sessionId: "s8", transcriptPath: transcript, cwd, sessionsDir });

  const text = readCapture(sessionsDir, "s8").find((r) => r.type === "turn")?.text as string;
  assert.ok(!text.includes("ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"));
  assert.match(text, /\[redacted\]/);
});

test("captureSession: no transcript path (an older hook binary) is a clean no-op", async () => {
  const { sessionsDir } = scratch();
  const result = await captureSession({ sessionId: "s9", sessionsDir });
  assert.equal(result.skipped, "no-transcript-path");
  assert.equal(fs.existsSync(sessionsDir), false, "nothing is even created");
});

test("captureSession: a transcript that no longer exists is a clean no-op", async () => {
  const { dir, sessionsDir, cwd } = scratch();
  const result = await captureSession({ sessionId: "s10", transcriptPath: path.join(dir, "gone.jsonl"), cwd, sessionsDir });
  assert.equal(result.skipped, "transcript-missing");
});

// Capture is opt-in, and the four ways a repo can fail to opt in all have
// to reach the same "captured nothing" outcome. Only the first of these
// used to be a skip -- the other three were captured by default, which is
// exactly what must not happen when an npm install is what put this code
// on someone's machine.

test("captureSession: a repo with `capture: {enabled: false}` is not captured", async () => {
  const { dir, transcript, sessionsDir } = scratch();
  fs.writeFileSync(transcript, humanTurn("this must not be captured"));
  fs.writeFileSync(path.join(dir, ".twing", "twing.yml"), "capture:\n  enabled: false\n");

  const result = await captureSession({ sessionId: "s11", transcriptPath: transcript, cwd: dir, sessionsDir });

  assert.equal(result.skipped, "disabled");
  assert.deepEqual(readCapture(sessionsDir, "s11"), []);
});

test("captureSession: a repo with no capture block is NOT captured -- absent is not consent", async () => {
  const { dir, transcript, sessionsDir } = scratch();
  fs.writeFileSync(transcript, humanTurn("this must not be captured"));
  // A manifest with a coordinator but nothing about capture: the common
  // shape of every repo that ran `twing init` before capture existed.
  fs.writeFileSync(path.join(dir, ".twing", "twing.yml"), "coordinator:\n  serverUrl: http://localhost:8787\n");

  const result = await captureSession({ sessionId: "s12", transcriptPath: transcript, cwd: dir, sessionsDir });

  assert.equal(result.skipped, "disabled");
  assert.deepEqual(readCapture(sessionsDir, "s12"), []);
});

test("captureSession: a directory that isn't a repo at all is not captured", async () => {
  const { transcript, sessionsDir } = scratch();
  fs.writeFileSync(transcript, humanTurn("this must not be captured"));
  const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "twing-not-a-repo-"));

  const result = await captureSession({ sessionId: "s14", transcriptPath: transcript, cwd: notARepo, sessionsDir });

  assert.equal(result.skipped, "disabled");
});

test("captureSession: no cwd at all is not captured -- there is no manifest to consent with", async () => {
  const { transcript, sessionsDir } = scratch();
  fs.writeFileSync(transcript, humanTurn("this must not be captured"));

  const result = await captureSession({ sessionId: "s15", transcriptPath: transcript, sessionsDir });

  assert.equal(result.skipped, "disabled");
});

test("captureSession: overlapping passes for one session serialize instead of double-writing", async () => {
  const { transcript, sessionsDir, cwd } = scratch();
  fs.writeFileSync(transcript, humanTurn("one") + humanTurn("two"));

  // UserPromptSubmit and SessionEnd can land close enough to overlap.
  const [a, b] = await Promise.all([
    captureSession({ sessionId: "s13", transcriptPath: transcript, cwd, sessionsDir }),
    captureSession({ sessionId: "s13", transcriptPath: transcript, cwd, sessionsDir }),
  ]);

  assert.equal(a.turnsWritten + b.turnsWritten, 2, "each turn captured exactly once across both passes");
  const texts = readCapture(sessionsDir, "s13")
    .filter((r) => r.type === "turn")
    .map((r) => r.text);
  assert.deepEqual(texts, ["one", "two"]);
});

// createRepoResolver runs against the real filesystem (the one place in
// capture that does), so these use real directories rather than fixtures.

test("createRepoResolver: a file inside a repo resolves to the repo root", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twing-resolver-"));
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.mkdirSync(path.join(dir, "src", "net"), { recursive: true });
  const resolve = createRepoResolver();

  // The file need not exist -- a Write names a path before creating it.
  assert.equal(resolve(path.join(dir, "src", "net", "retry.ts")), dir);
  assert.equal(resolve(dir), dir, "the repo root itself resolves to itself");
});

test("createRepoResolver: a path outside every repo resolves to undefined, not to itself", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twing-not-a-repo-"));
  const resolve = createRepoResolver();

  assert.equal(resolve(path.join(dir, "scratch.txt")), undefined, "inventing a repo here would let a scratch file act like a project");
});

test("createRepoResolver: the nearest repo root wins for a nested checkout", () => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "twing-outer-"));
  fs.mkdirSync(path.join(outer, ".git"), { recursive: true });
  const inner = path.join(outer, "vendor", "inner");
  fs.mkdirSync(path.join(inner, ".git"), { recursive: true });
  const resolve = createRepoResolver();

  assert.equal(resolve(path.join(inner, "src", "a.ts")), inner);
  assert.equal(resolve(path.join(outer, "src", "a.ts")), outer);
});

// Memoization is a precondition rather than an optimization: a session
// names paths tens of thousands of times across a handful of directories.
// Observed through behavior -- the answer survives the repo marker being
// deleted underneath it, which is only possible if it was cached.
test("createRepoResolver: repeated lookups are served from the cache", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twing-resolver-cache-"));
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  const resolve = createRepoResolver();

  assert.equal(resolve(path.join(dir, "src", "a.ts")), dir);
  fs.rmSync(path.join(dir, ".git"), { recursive: true, force: true });

  assert.equal(resolve(path.join(dir, "src", "b.ts")), dir, "a sibling path reuses the ancestors already walked");
});
