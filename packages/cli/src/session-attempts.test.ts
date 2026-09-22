/**
 * The guard rail between "the session id I was handed" and "the session id I
 * typed". Both failures it exists for happened on 2026-09-21, hours apart:
 * one agent transcribed `...c36a71` as `...c36e71`, another parsed the wrong
 * field out of a deny and registered the session id `--session`. Both got a
 * design the coordinator accepted and nothing would ever match, then a deny
 * loop with no diagnostic.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkSessionId, sessionsSeenFor } from "./session-attempts.js";

const PROJECT = "a".repeat(64);
const OTHER_PROJECT = "b".repeat(64);
const REAL = "01a0c765-4218-7300-a6fa-60c7a4c36a71";

/** A home where the gate has recorded these sessions, oldest first. */
function homeSeeing(records: { project?: string; session: string }[]): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "twing-attempts-"));
  const dir = path.join(home, ".twing", "sessions", "attempts");
  fs.mkdirSync(dir, { recursive: true });
  records.forEach(({ project = PROJECT, session }, index) => {
    const file = path.join(dir, `${project}.${session}`);
    fs.writeFileSync(file, "");
    // Distinct mtimes, so "most recent first" is actually exercised.
    const when = new Date(Date.now() - (records.length - index) * 60_000);
    fs.utimesSync(file, when, when);
  });
  return home;
}

test("the ways a uuid actually gets copied wrong are all fatal, and name the right id", () => {
  // One substitution was the first version of this check, and it is the
  // weakest of the four: a transposition is *two* substitutions, and a
  // dropped character changes the length so the strings never line up at
  // all. Both are ordinary ways to copy 36 characters wrong.
  const home = homeSeeing([{ session: REAL }]);
  const slips = {
    "one character wrong": REAL.replace(/a71$/, "e71"),
    "two characters wrong": REAL.replace(/a71$/, "e72"),
    "adjacent characters swapped": REAL.replace(/71$/, "17"),
    "a character dropped": REAL.slice(0, 20) + REAL.slice(21),
  };

  for (const [how, typo] of Object.entries(slips)) {
    const verdict = checkSessionId(PROJECT, typo, home);
    assert.equal(verdict?.fatal, true, `${how} must stop the command`);
    assert.ok(verdict.message.includes(REAL), `${how} must name the id that would have worked`);
    assert.match(verdict.message, /never match an edit/, "says why it matters, not just that it is wrong");
  }
});

test("a genuinely different session is reported, not treated as a typo", () => {
  // The bound has to stay far below the distance between two real uuids, or
  // this stops being a typo check and starts refusing other people's work.
  const home = homeSeeing([{ session: REAL }]);

  const verdict = checkSessionId(PROJECT, "99998888-7777-6666-5555-444433332222", home);

  assert.equal(verdict?.fatal, false);
});

test("short ids are matched exactly, never fuzzily", () => {
  // Two edits is a meaningful fraction of a short id: a harness numbering
  // sessions `ses_1`, `ses_2` would otherwise see each as a typo of the next.
  const home = homeSeeing([{ session: "ses_1" }]);

  assert.equal(checkSessionId(PROJECT, "ses_2", home)?.fatal, false, "a neighbour is not a typo at this length");
  assert.equal(checkSessionId(PROJECT, "ses_1", home), undefined);
});

test("a value that is a flag, not an id, is fatal wherever it came from", () => {
  // `--session` as the session id: what a wrong `awk` field produced. No
  // records needed to know this one is wrong -- a session id never begins
  // with a dash.
  for (const home of [homeSeeing([{ session: REAL }]), homeSeeing([])]) {
    const verdict = checkSessionId(PROJECT, "--session", home);
    assert.equal(verdict?.fatal, true);
    assert.match(verdict.message, /not a session id/);
  }
});

test("the id the gate actually saw passes silently", () => {
  const home = homeSeeing([{ session: REAL }]);
  assert.equal(checkSessionId(PROJECT, REAL, home), undefined);
});

test("a session that has not edited yet is told, not blocked", () => {
  // The case that matters most for not breaking anyone: registering *before*
  // the first edit is a normal thing to do -- an agent declaring its plan, a
  // developer starting work -- and the gate has records here from earlier
  // sessions. An earlier draft of this check refused it outright, which would
  // have broken the very workflow this repo's own CLAUDE.md recommends.
  const home = homeSeeing([{ session: REAL }]);

  const verdict = checkSessionId(PROJECT, "99998888-7777-6666-5555-444433332222", home);

  assert.equal(verdict?.fatal, false, "must not stop a legitimate early registration");
  assert.match(verdict.message, /normal when you register before the first edit/);
  assert.ok(verdict.message.includes(REAL), "still names what the gate has seen, in case it was a bad copy");
});

test("parallel sessions in one repo each pass on their own id", () => {
  // The reason records are per session rather than "the last one denied":
  // two agents working in the same repo must both be able to register.
  const second = "01a0c765-4218-7300-a6fa-99999999ffff";
  const home = homeSeeing([{ session: REAL }, { session: second }]);

  assert.equal(checkSessionId(PROJECT, REAL, home), undefined);
  assert.equal(checkSessionId(PROJECT, second, home), undefined);
  assert.deepEqual(sessionsSeenFor(PROJECT, home), [second, REAL], "most recent first");
});

test("no evidence means no opinion -- registering before the first edit still works", () => {
  // Claude Code's plan mode registers on every session before any edit, so
  // the gate has recorded nothing for that project yet. Refusing here would
  // break a working flow to guard against a typo that cannot be detected.
  const home = homeSeeing([]);
  assert.equal(checkSessionId(PROJECT, REAL, home), undefined);

  // Same when this project has no records but another does.
  const elsewhere = homeSeeing([{ project: OTHER_PROJECT, session: REAL }]);
  assert.equal(checkSessionId(PROJECT, "anything-at-all", elsewhere), undefined);
});

test("records are scoped to their project", () => {
  const home = homeSeeing([{ project: OTHER_PROJECT, session: REAL }, { session: "01a0c765-4218-7300-a6fa-000000000001" }]);

  assert.deepEqual(sessionsSeenFor(OTHER_PROJECT, home), [REAL]);
  assert.equal(sessionsSeenFor(PROJECT, home).includes(REAL), false, "another project's session is not evidence here");
});

test("an unreadable or absent attempts directory is silence, not a crash", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "twing-attempts-none-"));
  assert.deepEqual(sessionsSeenFor(PROJECT, empty), []);
  assert.equal(checkSessionId(PROJECT, REAL, empty), undefined);
});
