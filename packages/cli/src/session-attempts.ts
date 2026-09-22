/**
 * Telling a real session id from one that was mistyped on the way here.
 *
 * `twing design register --session <id>` binds a design to one agent session,
 * and the id reaches it by being copied out of a deny message -- 36 random
 * characters, no redundancy, required byte-exact. When a character is wrong
 * the coordinator accepts the registration (it has no way to know that
 * session never existed), the gate keeps denying the real session, and the
 * two states are indistinguishable from the server's side: "registered for a
 * session that doesn't exist" looks exactly like "not registered".
 *
 * The agent then sits in a deny loop with no diagnostic, which is one step
 * from going around the gate -- which is what happened, on 2026-09-21, when a
 * Codex session copied `...c36a71` as `...c36e71`, failed three times, and
 * edited the file through the shell instead. The same loop caught a second
 * agent the same day from the other direction: it parsed the wrong field out
 * of the deny and registered the session id `--session`.
 *
 * So the gate records which sessions it actually evaluated for a project
 * (`hook/session_attempts.go`), and this reads those records back. It is a
 * guard rail, never a gate: with no evidence either way, registration
 * proceeds exactly as before.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Where `hook/session_attempts.go` leaves its records. */
export function sessionAttemptsDir(home: string = os.homedir()): string {
  return path.join(home, ".twing", "sessions", "attempts");
}

/**
 * Every session id the gate has evaluated for this project, most recent
 * first. Empty when the gate has never run here -- a fresh machine, a repo
 * whose first edit hasn't happened yet, or a hook too old to record.
 */
export function sessionsSeenFor(projectId: string, home: string = os.homedir()): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sessionAttemptsDir(home), { withFileTypes: true });
  } catch {
    return [];
  }

  const prefix = `${projectId}.`;
  const found: { id: string; at: number }[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
    const id = entry.name.slice(prefix.length);
    if (!id) continue;
    let at = 0;
    try {
      at = fs.statSync(path.join(sessionAttemptsDir(home), entry.name)).mtimeMs;
    } catch {
      continue; // pruned underneath us
    }
    found.push({ id, at });
  }
  return found.sort((a, b) => b.at - a.at).map((f) => f.id);
}

/** What the caller should do about the session id it was given. */
export interface SessionVerdict {
  /** True when registering would certainly be pointless, so the command
   * should fail rather than create a design nothing can match. */
  fatal: boolean;
  message: string;
}

/**
 * Whether the session id looks wrong, and how sure we are.
 *
 * The distinction matters more than it first appears, because "the gate has
 * not seen this session" has two completely different causes. One is a
 * mistyped id, where registering is guaranteed to be useless. The other is a
 * session that simply has not edited anything yet -- which is a *normal* way
 * to register: an agent declaring its plan up front, or a developer
 * registering before starting. Treating the second as the first would break
 * a working flow to guard against a typo, so only the cases we can be sure
 * about are fatal:
 *
 *  - **Not an id at all** (`--session`, an empty flag value). A session id
 *    never begins with `-`. This is the exact shape of a command line whose
 *    argument parsing went wrong, and there is no legitimate reading of it.
 *  - **Within two edits of a session the gate has seen here.** Two session
 *    ids that close are a transcription slip, not two sessions: they are 36
 *    characters of uuid (or 30 for OpenCode's `ses_...`), so two genuinely
 *    different ones differ in dozens of positions, not two. One edit is too
 *    strict to be useful -- it cannot see a transposition, which is two
 *    substitutions, nor a dropped character, which changes the length.
 *
 * Anything else the gate has not seen is reported and allowed: the message
 * is worth printing, the registration is not worth blocking.
 */
export function checkSessionId(projectId: string, session: string, home: string = os.homedir()): SessionVerdict | undefined {
  if (session.startsWith("-")) {
    return {
      fatal: true,
      message:
        `twing: "${session}" is not a session id -- it looks like a command-line flag that was read as one. ` +
        "Pass the id from the deny message that sent you here.",
    };
  }

  const seen = sessionsSeenFor(projectId, home);
  if (seen.length === 0 || seen.includes(session)) return undefined;

  const near = seen.find((candidate) => isTranscriptionSlip(candidate, session));
  if (near) {
    return {
      fatal: true,
      message: [
        `twing: no session ${session} has reached the design gate in this repo, so a design registered for it ` +
          "would never match an edit.",
        "",
        `  Did you mean  ${near}`,
        `  rather than   ${session}`,
        "",
        "  (they are a character or two apart -- copy the id from the deny message whole)",
      ].join("\n"),
    };
  }

  return {
    fatal: false,
    message: [
      `twing: heads up -- no session ${session} has edited anything in this repo yet, so nothing has been checked ` +
        "against this design so far. That is normal when you register before the first edit; if you meant to " +
        "answer a deny, check you copied its session id.",
      "",
      "  Sessions the gate has seen here, most recent first:",
      ...seen.slice(0, 3).map((id) => `    ${id}`),
    ].join("\n"),
  };
}

/** Edits allowed before two ids stop looking like the same one typed twice. */
const SLIP_DISTANCE = 2;

/** Below this length, only an exact match counts. Two edits is a meaningful
 * fraction of a short id, and a harness with sequential ids (`ses_1`,
 * `ses_2`) would see its neighbours as typos of each other. Every id twing
 * has seen is 30 or more characters, so nothing real is excluded. */
const SLIP_MIN_LENGTH = 16;

/**
 * Whether one id is plausibly the other, typed wrong.
 *
 * Levenshtein rather than a positional comparison, because the two slips that
 * matter most are invisible to one: a transposition (`ab` -> `ba`) differs in
 * two positions, and a dropped character changes the length so the strings
 * never line up at all. Both are ordinary ways to copy a uuid wrong.
 *
 * Two edits is safe at these lengths: a uuid carries far more entropy than
 * two characters, so two distinct sessions landing within this distance is
 * not a case that occurs. The risk runs the other way -- being too strict and
 * silently letting a mistyped id register a design nothing can match.
 */
function isTranscriptionSlip(a: string, b: string): boolean {
  if (a === b) return false;
  if (a.length < SLIP_MIN_LENGTH || b.length < SLIP_MIN_LENGTH) return false;
  if (Math.abs(a.length - b.length) > SLIP_DISTANCE) return false;
  return editDistance(a, b, SLIP_DISTANCE) <= SLIP_DISTANCE;
}

/** Levenshtein distance, giving up once it exceeds `max` -- the answer is
 * only ever compared against that bound, and abandoning early keeps this
 * linear in practice for the strings it rejects. */
function editDistance(a: string, b: string, max: number): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      best = Math.min(best, current[j]);
    }
    if (best > max) return max + 1;
    previous = current;
  }
  return previous[b.length];
}
