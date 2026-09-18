/**
 * `OpenCodeSqliteSource` against a real SQLite database with OpenCode's real
 * schema.
 *
 * The conformance suite proves the *contract* using a fake reader; this
 * proves the half a fake cannot: that the SQL is valid, the pair comparison
 * pages correctly, and OpenCode's actual JSON shapes translate. Those are
 * exactly the things that break when the schema moves and a hand-written fake
 * happily keeps passing.
 *
 * Skipped wholesale when `node:sqlite` is unavailable, rather than failing --
 * twing's floor is Node 22.5 so it is normally there, but the suite must
 * still run on a contributor's older Node without a red herring.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { OpenCodeSqliteSource, openSqliteReader, toTranscriptEntryShape } from "./opencode-sqlite-source.js";
import { filterTranscriptEntry } from "@twing/core";

let DatabaseSync: (new (p: string) => { exec(sql: string): void; prepare(sql: string): { run(...a: unknown[]): void }; close(): void }) | undefined;
try {
  ({ DatabaseSync } = (await import("node:sqlite")) as never);
} catch {
  DatabaseSync = undefined;
}
const hasSqlite = DatabaseSync !== undefined;

/** OpenCode's real DDL, copied from a live database (2026-09-18). */
function makeDb(): { dbPath: string; addMessage: (m: { id: string; session: string; created: number; role: string; completed?: number }) => void; addPart: (messageId: string, data: unknown, id?: string) => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twing-oc-db-"));
  const dbPath = path.join(dir, "opencode.db");
  const db = new DatabaseSync!(dbPath);
  db.exec(
    "CREATE TABLE `message` (`id` text PRIMARY KEY, `session_id` text NOT NULL, `time_created` integer NOT NULL, `time_updated` integer NOT NULL, `data` text NOT NULL);" +
      "CREATE TABLE `part` (`id` text PRIMARY KEY, `message_id` text NOT NULL, `session_id` text NOT NULL, `time_created` integer NOT NULL, `time_updated` integer NOT NULL, `data` text NOT NULL);",
  );
  let partSeq = 0;
  return {
    dbPath,
    addMessage({ id, session, created, role, completed }) {
      const time: Record<string, number> = { created };
      if (completed !== undefined) time.completed = completed;
      db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)")
        .run(id, session, created, created, JSON.stringify({ role, time }));
    },
    addPart(messageId, data, id) {
      db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id ?? `prt_${String(partSeq++).padStart(4, "0")}`, messageId, "s1", 0, 0, JSON.stringify(data));
    },
  };
}

test("OpenCodeSqliteSource: reads a real database, scoped to one session", { skip: !hasSqlite }, async () => {
  const db = makeDb();
  db.addMessage({ id: "m1", session: "s1", created: 100, role: "user" });
  db.addPart("m1", { type: "text", text: "mine" });
  // A second session in the same machine-global database must not leak in --
  // OpenCode stores every project's conversations in this one file.
  db.addMessage({ id: "m2", session: "s2", created: 110, role: "user" });
  db.addPart("m2", { type: "text", text: "someone else's" });

  const source = new OpenCodeSqliteSource(db.dbPath, "s1");
  const seen: unknown[] = [];
  await source.read(source.beginning, ({ value }) => void seen.push(value));

  assert.equal(seen.length, 1);
  assert.equal(filterTranscriptEntry(seen[0]).turn?.text, "mine");
});

test("OpenCodeSqliteSource: pages by (time_created, id), including ties", { skip: !hasSqlite }, async () => {
  // Two messages created in the same millisecond is not hypothetical -- the
  // sample database had assistant messages 2ms apart. If the cursor were
  // time alone, a tie would either repeat or skip one.
  const db = makeDb();
  db.addMessage({ id: "m_a", session: "s1", created: 100, role: "user" });
  db.addPart("m_a", { type: "text", text: "first" });
  db.addMessage({ id: "m_b", session: "s1", created: 100, role: "user" });
  db.addPart("m_b", { type: "text", text: "second" });

  const source = new OpenCodeSqliteSource(db.dbPath, "s1");
  const afters: string[] = [];
  const all: unknown[] = [];
  await source.read(source.beginning, ({ value, after }) => {
    all.push(value);
    afters.push(after);
  });
  assert.deepEqual(all.map((v) => filterTranscriptEntry(v).turn?.text), ["first", "second"]);

  const rest: unknown[] = [];
  await source.read(afters[0], ({ value }) => void rest.push(value));
  assert.deepEqual(rest.map((v) => filterTranscriptEntry(v).turn?.text), ["second"], "the tie must not repeat or swallow the second message");
});

test("OpenCodeSqliteSource: stops at a still-streaming assistant message", { skip: !hasSqlite }, async () => {
  const db = makeDb();
  db.addMessage({ id: "m1", session: "s1", created: 100, role: "user" });
  db.addPart("m1", { type: "text", text: "done" });
  db.addMessage({ id: "m2", session: "s1", created: 110, role: "assistant" }); // no time.completed
  db.addPart("m2", { type: "text", text: "half written" });
  // A later, complete message must NOT be reached past the incomplete one --
  // that would leave a permanent hole.
  db.addMessage({ id: "m3", session: "s1", created: 120, role: "user", completed: 121 });
  db.addPart("m3", { type: "text", text: "later" });

  const source = new OpenCodeSqliteSource(db.dbPath, "s1");
  const seen: unknown[] = [];
  const next = await source.read(source.beginning, ({ value }) => void seen.push(value));

  assert.deepEqual(seen.map((v) => filterTranscriptEntry(v).turn?.text), ["done"]);
  assert.equal(next, "t:100,m1", "the cursor must stop before the incomplete message, not past it");
});

test("OpenCodeSqliteSource: a tool part contributes its paths and nothing else", { skip: !hasSqlite }, async () => {
  const db = makeDb();
  db.addMessage({ id: "m1", session: "s1", created: 100, role: "assistant", completed: 101 });
  db.addPart("m1", { type: "text", text: "Editing it." });
  db.addPart("m1", {
    type: "tool",
    tool: "edit",
    state: {
      status: "completed",
      // OpenCode's real spelling, verified against a live database. If this
      // is not translated to `file_path`, the filter finds no path, no repo
      // resolves, and capture never starts -- while every test that does not
      // go through `filterTranscriptEntry` still passes.
      input: { filePath: "/repo/src/a.ts", oldString: "a", newString: "b" },
      output: "SECRET OUTPUT that must never be captured",
      metadata: { output: "also secret" },
    },
  });

  const source = new OpenCodeSqliteSource(db.dbPath, "s1");
  const seen: unknown[] = [];
  await source.read(source.beginning, ({ value }) => void seen.push(value));

  const filtered = filterTranscriptEntry(seen[0]);
  assert.equal(filtered.turn?.text, "Editing it.");
  assert.deepEqual(filtered.paths, ["/repo/src/a.ts"]);
  assert.ok(!JSON.stringify(seen[0]).includes("SECRET OUTPUT"), "tool output must be dropped at translation, not left for the filter");
});

test("OpenCodeSqliteSource: grep and glob's `path` needs no translation", { skip: !hasSqlite }, async () => {
  const db = makeDb();
  db.addMessage({ id: "m1", session: "s1", created: 100, role: "assistant", completed: 101 });
  db.addPart("m1", { type: "text", text: "Looking." });
  db.addPart("m1", { type: "tool", tool: "grep", state: { input: { path: "/repo/README.md", pattern: "twing" } } });

  const source = new OpenCodeSqliteSource(db.dbPath, "s1");
  const seen: unknown[] = [];
  await source.read(source.beginning, ({ value }) => void seen.push(value));

  const filtered = filterTranscriptEntry(seen[0]);
  assert.deepEqual(filtered.paths, ["/repo/README.md"]);
  // The pattern rides along in the intermediate entry shape and is dropped by
  // the filter, which is the only thing `transcript.ts` ever persists. The
  // translation must not promote it to a path by widening the key list.
  assert.ok(!JSON.stringify(filtered).includes("twing"), "a grep pattern is tool content, not a path");
});

test("OpenCodeSqliteSource: reasoning and step bookkeeping are dropped", { skip: !hasSqlite }, async () => {
  // The Claude Code side keeps text and tool calls and nothing else; private
  // chain-of-thought is not captured there and must not be here.
  const db = makeDb();
  db.addMessage({ id: "m1", session: "s1", created: 100, role: "assistant", completed: 101 });
  db.addPart("m1", { type: "reasoning", text: "private deliberation" });
  db.addPart("m1", { type: "step-start" });
  db.addPart("m1", { type: "text", text: "the answer" });
  db.addPart("m1", { type: "step-finish" });

  const source = new OpenCodeSqliteSource(db.dbPath, "s1");
  const seen: unknown[] = [];
  await source.read(source.beginning, ({ value }) => void seen.push(value));

  assert.equal(filterTranscriptEntry(seen[0]).turn?.text, "the answer");
  assert.ok(!JSON.stringify(seen[0]).includes("private deliberation"), "reasoning must not be captured");
});

test("OpenCodeSqliteSource: an unparseable message row is skipped without stalling the cursor", { skip: !hasSqlite }, async () => {
  const db = makeDb();
  const raw = new DatabaseSync!(db.dbPath);
  raw.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)").run("m1", "s1", 100, 100, "{not json");
  raw.close();
  db.addMessage({ id: "m2", session: "s1", created: 110, role: "user" });
  db.addPart("m2", { type: "text", text: "after the bad row" });

  const source = new OpenCodeSqliteSource(db.dbPath, "s1");
  const seen: unknown[] = [];
  await source.read(source.beginning, ({ value }) => void seen.push(value));

  assert.deepEqual(seen.map((v) => filterTranscriptEntry(v).turn?.text), ["after the bad row"], "a corrupt row must not block everything behind it");
});

test("openSqliteReader: a missing or non-database file is undefined, not a throw", { skip: !hasSqlite }, async () => {
  assert.equal(await openSqliteReader(path.join(os.tmpdir(), "twing-no-such-db-xyz", "x.db")), undefined);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twing-oc-notdb-"));
  const notDb = path.join(dir, "notadb.db");
  fs.writeFileSync(notDb, "this is not a database");
  assert.equal(await openSqliteReader(notDb), undefined);
});

test("toTranscriptEntryShape: produces what filterTranscriptEntry reads", () => {
  // The seam's actual contract with the shared pipeline: whatever this
  // returns has to survive the filter unchanged. Pure, so it runs with or
  // without node:sqlite.
  const entry = toTranscriptEntryShape(
    { role: "user", time: { created: 1789310564902 } },
    [{ type: "text", text: "hello" }],
    "/repo",
  );

  const filtered = filterTranscriptEntry(entry);
  assert.equal(filtered.turn?.role, "user");
  assert.equal(filtered.turn?.text, "hello");
  assert.match(filtered.turn!.ts!, /^2026-/, "the epoch millisecond timestamp becomes an ISO string the filter accepts");
});
