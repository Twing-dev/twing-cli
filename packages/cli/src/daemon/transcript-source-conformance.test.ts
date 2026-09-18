/**
 * One contract, run against every `TranscriptSource`.
 *
 * The seam exists so capture can read a harness that is not an append-only
 * file. That only holds if every source agrees on the handful of behaviours
 * the shared pipeline depends on -- and those are easy to get subtly wrong in
 * a way that shows up as "a session was captured twice" or "the last turn
 * never arrived" months later, on someone else's machine.
 *
 * So the rules live here once, phrased in terms no implementation can
 * special-case: build a source over a fixture, read it, assert the shape of
 * what came back. A new source adds one entry to `sources` below and has to
 * pass all of it.
 *
 * Deliberately says nothing about cursor *format*. A cursor is opaque; a test
 * that knew a byte offset from a `(time, id)` pair would be testing the one
 * thing the seam exists to hide. Byte-level assertions belong in
 * `transcript-source.test.ts`, which is allowed to know it is reading a file.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ClaudeCodeJsonlSource, type TranscriptSource } from "./transcript-source.js";
import { OpenCodeSqliteSource, type SqliteReader, type SqliteRow, parseTimeCursor } from "./opencode-sqlite-source.js";

/** What a conformance fixture has to be able to express, in harness-neutral
 * terms. `append` is what makes the incremental-read rules testable. */
interface Fixture {
  /** A finished user turn carrying this text. */
  addUserTurn(text: string): void;
  /** A finished assistant turn carrying this text. */
  addAssistantTurn(text: string): void;
  /** A turn that has started but not finished -- a half-written JSONL line,
   * an assistant message still streaming. Must not be handed over. */
  addUnfinishedTurn(): void;
  /** Finish whatever `addUnfinishedTurn` started. */
  finishUnfinishedTurn(text: string): void;
  source(): TranscriptSource;
}

// --- Claude Code: a JSONL file ----------------------------------------------

function jsonlFixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twing-conf-jsonl-"));
  const file = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(file, "");
  const line = (role: "user" | "assistant", text: string) =>
    JSON.stringify({ type: role, message: { role, content: [{ type: "text", text }] } }) + "\n";

  return {
    addUserTurn: (t) => fs.appendFileSync(file, line("user", t)),
    addAssistantTurn: (t) => fs.appendFileSync(file, line("assistant", t)),
    addUnfinishedTurn() {
      // A genuinely torn line: the harness has written an opening fragment
      // and not yet the text. Splitting a *known* line at a byte offset would
      // be a weaker fixture -- the text has to still be undecided here, the
      // way it is for an assistant message that has not finished streaming.
      fs.appendFileSync(file, '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"');
    },
    finishUnfinishedTurn(text) {
      fs.appendFileSync(file, `${text}"}]}}\n`);
    },
    source: () => new ClaudeCodeJsonlSource(file),
  };
}

// --- OpenCode: rows in SQLite -----------------------------------------------

/** An in-memory stand-in for the real database. The point of conformance is
 * the *contract*, not the engine, and a fake keeps this suite runnable on a
 * machine that has never installed OpenCode. `opencode-sqlite-source.test.ts`
 * exercises the real schema separately. */
function sqliteFixture(): Fixture {
  const rows: SqliteRow[] = [];
  const parts = new Map<string, { data: string }[]>();
  let clock = 1_000_000;
  let pendingId: string | undefined;

  const push = (role: string, text: string | undefined, completed: boolean) => {
    const id = `msg_${String(rows.length).padStart(4, "0")}`;
    const time: Record<string, number> = { created: clock };
    if (completed) time.completed = clock + 1;
    clock += 10;
    rows.push({ id, time_created: time.created, data: JSON.stringify({ role, time }) });
    parts.set(id, text === undefined ? [] : [{ data: JSON.stringify({ type: "text", text }) }]);
    return id;
  };

  const reader: SqliteReader = {
    messages(_sessionId, after) {
      return rows.filter((r) => {
        if (!after) return true;
        return r.time_created > after.timeCreated || (r.time_created === after.timeCreated && r.id > after.id);
      });
    },
    parts: (id) => parts.get(id) ?? [],
    close() {},
  };

  return {
    addUserTurn: (t) => void push("user", t, true),
    addAssistantTurn: (t) => void push("assistant", t, true),
    addUnfinishedTurn() {
      // An assistant message that has started streaming: the row exists, the
      // text may even be there, but `time.completed` is not.
      pendingId = push("assistant", undefined, false);
    },
    finishUnfinishedTurn(text) {
      const row = rows.find((r) => r.id === pendingId)!;
      const data = JSON.parse(row.data) as { role: string; time: Record<string, number> };
      data.time.completed = data.time.created + 1;
      row.data = JSON.stringify(data);
      parts.set(pendingId!, [{ data: JSON.stringify({ type: "text", text }) }]);
    },
    source: () => new OpenCodeSqliteSource("ignored.db", "s1", async () => reader),
  };
}

const sources: { name: string; fixture: () => Fixture }[] = [
  { name: "ClaudeCodeJsonlSource", fixture: jsonlFixture },
  { name: "OpenCodeSqliteSource", fixture: sqliteFixture },
];

/** Reads everything from `cursor`, returning the entries and the new cursor. */
async function readFrom(source: TranscriptSource, cursor: string) {
  const values: unknown[] = [];
  const next = await source.read(cursor, ({ value }) => void values.push(value));
  return { values, next };
}

/** Every source must produce entries `filterTranscriptEntry` can read, so the
 * shared pipeline works unchanged. Pulling the text back out is how a test
 * says "this turn arrived" without knowing the harness. */
function textOf(value: unknown): string {
  const v = value as { message?: { content?: { type?: string; text?: string }[] } };
  return (v.message?.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}

for (const { name, fixture } of sources) {
  test(`${name}: reading from the beginning yields every finished turn in order`, async () => {
    const f = fixture();
    f.addUserTurn("first");
    f.addAssistantTurn("second");
    const source = f.source();

    const { values } = await readFrom(source, source.beginning);

    assert.deepEqual(values.map(textOf), ["first", "second"]);
  });

  test(`${name}: a second read from the returned cursor yields only what was added since`, async () => {
    const f = fixture();
    f.addUserTurn("first");
    const source = f.source();
    const { next } = await readFrom(source, source.beginning);

    f.addUserTurn("second");
    const { values } = await readFrom(source, next);

    assert.deepEqual(values.map(textOf), ["second"], "no re-delivery of what the first pass already returned");
  });

  test(`${name}: re-reading from the same cursor is idempotent`, async () => {
    // The pipeline appends what it is handed. A source that returned a turn
    // twice for one cursor would duplicate it in the capture file.
    const f = fixture();
    f.addUserTurn("only");
    const source = f.source();

    const a = await readFrom(source, source.beginning);
    const b = await readFrom(source, source.beginning);

    assert.deepEqual(a.values.map(textOf), b.values.map(textOf));
    assert.equal(a.next, b.next, "the same input cursor must produce the same output cursor");
  });

  test(`${name}: an unfinished turn is not handed over, and is not skipped either`, async () => {
    // The rule the whole seam turns on. A half-written JSONL line and a
    // still-streaming assistant message are the same situation: hand it over
    // now and you capture half of it, then move past it and lose the rest.
    const f = fixture();
    f.addUserTurn("finished");
    f.addUnfinishedTurn();
    const source = f.source();

    const first = await readFrom(source, source.beginning);
    assert.deepEqual(first.values.map(textOf), ["finished"], "the unfinished turn must not appear");

    f.finishUnfinishedTurn("now complete");
    const second = await readFrom(source, first.next);

    assert.deepEqual(second.values.map(textOf), ["now complete"], "and must appear whole, exactly once, on the pass after it finishes");
  });

  test(`${name}: atEnd is false when a finished turn is waiting and true once it is read`, async () => {
    const f = fixture();
    f.addUserTurn("waiting");
    const source = f.source();

    assert.equal(await source.atEnd(source.beginning), false);
    const { next } = await readFrom(source, source.beginning);
    assert.equal(await source.atEnd(next), true);
  });

  test(`${name}: atEnd never claims the end while an unfinished turn is still pending`, async () => {
    // `atEnd` is allowed to be conservative but never optimistic, and the two
    // errors are not symmetric:
    //
    //  - claiming the end while readable content exists means the pipeline
    //    skips it, and since nothing revisits a cursor it stays skipped --
    //    silent, permanent data loss;
    //  - claiming there is more when there is not costs exactly one read that
    //    returns nothing.
    //
    // So the contract is the safe direction only. ClaudeCodeJsonlSource
    // answers with a `stat` and reports "more" for a half-written line it
    // cannot yet hand over; making that precise would turn an O(1) check into
    // a scan for a newline on every pass, buying nothing. OpenCodeSqliteSource
    // is precise because it already has to parse the row to know. Both are
    // conforming; a new source should err the same way.
    const f = fixture();
    f.addUnfinishedTurn();
    const source = f.source();

    const atEnd = await source.atEnd(source.beginning);
    if (!atEnd) {
      // Conservative is fine -- but it must genuinely yield nothing.
      const { values } = await readFrom(source, source.beginning);
      assert.deepEqual(values, [], "if it says there is more, the read must still refuse the unfinished turn");
    }

    // The rule that is not negotiable: once the turn finishes, atEnd must say
    // so, whichever way it answered before.
    f.finishUnfinishedTurn("now complete");
    assert.equal(await source.atEnd(source.beginning), false, "a finished turn is always something to read");
  });

  test(`${name}: resume of a cursor this source did not mint falls back to the beginning`, async () => {
    const f = fixture();
    f.addUserTurn("only");
    const source = f.source();

    for (const foreign of ["", "nonsense", "x:1"]) {
      const resumed = await source.resume(foreign);
      const { values } = await readFrom(source, resumed);
      assert.deepEqual(values.map(textOf), ["only"], `a ${JSON.stringify(foreign)} cursor must read from the start, not silently skip`);
    }
  });

  test(`${name}: resume of its own cursor preserves position`, async () => {
    const f = fixture();
    f.addUserTurn("first");
    const source = f.source();
    const { next } = await readFrom(source, source.beginning);

    f.addUserTurn("second");
    const resumed = await source.resume(next);
    const { values } = await readFrom(source, resumed);

    assert.deepEqual(values.map(textOf), ["second"], "a round trip through resume must not lose or repeat anything");
  });

  test(`${name}: each entry carries a cursor that resumes immediately after it`, async () => {
    const f = fixture();
    f.addUserTurn("first");
    f.addUserTurn("second");
    f.addUserTurn("third");
    const source = f.source();

    const afters: string[] = [];
    await source.read(source.beginning, ({ after }) => void afters.push(after));

    const { values } = await readFrom(source, afters[0]);
    assert.deepEqual(values.map(textOf), ["second", "third"], "resuming from the first entry's cursor skips exactly that entry");
  });

  test(`${name}: reading an empty transcript yields nothing and stays at the beginning`, async () => {
    const f = fixture();
    const source = f.source();

    const { values, next } = await readFrom(source, source.beginning);

    assert.deepEqual(values, []);
    assert.equal(await source.atEnd(next), true);
  });
}

// --- OpenCode-specific degrade ----------------------------------------------

test("OpenCodeSqliteSource: an unavailable database degrades to nothing, never an error", async () => {
  // node:sqlite missing, OpenCode never installed, or the file unreadable --
  // all one answer, on the daemon's event loop where a throw would be noise.
  const source = new OpenCodeSqliteSource("/nope/opencode.db", "s1", async () => undefined);

  assert.equal(await source.exists(), false);
  assert.equal(await source.atEnd(source.beginning), true);
  const { values, next } = await readFrom(source, source.beginning);
  assert.deepEqual(values, []);
  assert.equal(next, source.beginning, "a cursor must not move when nothing could be read");
});

test("parseTimeCursor: accepts its own cursors and rejects everything else", () => {
  assert.deepEqual(parseTimeCursor("t:1789310564902,msg_09b3"), { timeCreated: 1789310564902, id: "msg_09b3" });
  assert.equal(parseTimeCursor(undefined), undefined);
  assert.equal(parseTimeCursor(""), undefined);
  assert.equal(parseTimeCursor("b:22696087"), undefined, "a JSONL cursor is not one of ours");
  assert.equal(parseTimeCursor("t:notanumber,msg"), undefined);
  assert.equal(parseTimeCursor("t:123"), undefined, "no id");
  assert.equal(parseTimeCursor("t:123,"), undefined, "empty id");
});
