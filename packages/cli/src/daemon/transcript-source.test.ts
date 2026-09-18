/**
 * `ClaudeCodeJsonlSource`'s own tests -- the byte-level half of session
 * capture.
 *
 * These assertions name byte offsets on purpose, which is exactly what
 * `transcript.test.ts` may no longer do: a cursor is opaque to every caller,
 * but not to the source that mints it. Anything here phrased in bytes is
 * testing this implementation; anything phrased in captured turns belongs on
 * the other side of the seam.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { ClaudeCodeJsonlSource, byteOffsetOf } from "./transcript-source.js";

function scratchFile(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twing-source-"));
  const file = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(file, contents);
  return file;
}

const line = (text: string) => JSON.stringify({ type: "user", text }) + "\n";

async function readAll(source: ClaudeCodeJsonlSource, from?: string) {
  const values: unknown[] = [];
  const cursor = await source.read(from ?? source.beginning, ({ value }) => void values.push(value));
  return { values, cursor };
}

test("byteOffsetOf: accepts this source's own cursors and a legacy bare number", () => {
  assert.equal(byteOffsetOf("b:0"), 0);
  assert.equal(byteOffsetOf("b:22696087"), 22696087);
  // Every state file written before the TranscriptSource seam holds a bare
  // number. Rejecting one is silent data loss, not an error: capture would
  // restart from byte zero and re-upload the whole session.
  assert.equal(byteOffsetOf("22696087"), 22696087);
  assert.equal(byteOffsetOf(undefined), undefined);
  assert.equal(byteOffsetOf(""), undefined);
  assert.equal(byteOffsetOf("b:-1"), undefined);
  assert.equal(byteOffsetOf("b:not-a-number"), undefined);
  // A cursor minted by some other source must never decode as one of ours.
  assert.equal(byteOffsetOf("t:1737180000000,msg_01"), undefined);
});

test("ClaudeCodeJsonlSource: a partial trailing line is left outside the returned cursor", async () => {
  const complete = line("complete turn");
  const file = scratchFile(complete + line("partial turn").slice(0, 20));
  const source = new ClaudeCodeJsonlSource(file);

  const { values, cursor } = await readAll(source);

  assert.equal(values.length, 1, "only the complete line is handed over");
  assert.equal(cursor, `b:${Buffer.byteLength(complete)}`, "the cursor stops at the last complete line");
});

test("ClaudeCodeJsonlSource: resume past the end of a shrunken transcript returns the beginning", async () => {
  const file = scratchFile(line("a long first prompt that makes the file big"));
  const source = new ClaudeCodeJsonlSource(file);
  const { cursor } = await readAll(source);

  fs.writeFileSync(file, line("short"));

  assert.equal(await source.resume(cursor), source.beginning, "a cursor past EOF cannot be read from");
  assert.equal(await source.resume(`b:0`), "b:0", "a cursor still inside the file survives");
});

test("ClaudeCodeJsonlSource: resume accepts a legacy numeric offset as a cursor", async () => {
  const first = line("first");
  const file = scratchFile(first + line("second"));
  const source = new ClaudeCodeJsonlSource(file);

  // Exactly what a pre-seam state file holds: JSON.stringify of a number.
  const resumed = await source.resume(String(Buffer.byteLength(first)));
  assert.equal(resumed, `b:${Buffer.byteLength(first)}`);

  const { values } = await readAll(source, resumed);
  assert.equal(values.length, 1, "resuming from the legacy watermark re-reads only what followed it");
});

test("ClaudeCodeJsonlSource: each entry carries the cursor immediately after it", async () => {
  const a = line("a");
  const b = line("b");
  const file = scratchFile(a + b);
  const source = new ClaudeCodeJsonlSource(file);

  const afters: string[] = [];
  await source.read(source.beginning, ({ after }) => void afters.push(after));

  assert.deepEqual(afters, [`b:${Buffer.byteLength(a)}`, `b:${Buffer.byteLength(a + b)}`]);
});

test("ClaudeCodeJsonlSource: a torn or malformed line is skipped, never fatal", async () => {
  const good = line("kept");
  const file = scratchFile(good + "{not json at all}\n" + line("also kept"));
  const source = new ClaudeCodeJsonlSource(file);

  const { values } = await readAll(source);

  assert.equal(values.length, 2, "the malformed line is dropped and the rest still read");
});

test("ClaudeCodeJsonlSource: a multi-byte character does not desynchronise the cursor", async () => {
  // The byte/character distinction the chunked reader is careful about: a
  // line counted in characters would leave every later cursor short.
  const wide = line("días de café — ☕");
  const file = scratchFile(wide + line("after"));
  const source = new ClaudeCodeJsonlSource(file);

  const afters: string[] = [];
  await source.read(source.beginning, ({ after }) => void afters.push(after));

  assert.equal(afters[0], `b:${Buffer.byteLength(wide)}`);
  assert.ok(Buffer.byteLength(wide) > wide.length, "the fixture is genuinely multi-byte");
});

test("ClaudeCodeJsonlSource: exists and atEnd report a missing transcript rather than throwing", async () => {
  const source = new ClaudeCodeJsonlSource(path.join(os.tmpdir(), "twing-source-does-not-exist", "nope.jsonl"));

  assert.equal(await source.exists(), false);
  assert.equal(await source.atEnd(source.beginning), true);
  const { values } = await readAll(source);
  assert.deepEqual(values, [], "reading a missing transcript yields nothing, not an error");
});

test("ClaudeCodeJsonlSource: atEnd is true only once the cursor has caught up", async () => {
  const file = scratchFile(line("one"));
  const source = new ClaudeCodeJsonlSource(file);

  assert.equal(await source.atEnd(source.beginning), false);
  const { cursor } = await readAll(source);
  assert.equal(await source.atEnd(cursor), true);

  fs.appendFileSync(file, line("two"));
  assert.equal(await source.atEnd(cursor), false, "an append makes the same cursor no longer the end");
});
