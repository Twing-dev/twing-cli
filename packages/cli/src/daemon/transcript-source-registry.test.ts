/**
 * Descriptor resolution -- the seam between "what the harness said" and
 * "which reader we build".
 *
 * Every test here is really the same test: **a capture that cannot happen
 * must say so.** That is not a style preference. Both bugs found while
 * building this (a tool key spelled `filePath` where the filter wanted
 * `file_path`, and a database looked for under `~/.local/share` when the user
 * had moved it) produced a system that looked completely healthy and captured
 * nothing at all, and neither was caught by a test, because a test that only
 * asserts the happy path passes identically in both worlds.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveTranscriptSource, registerTranscriptSource } from "./transcript-source.js";
import { sourceIdentity, captureSession } from "./transcript.js";
import { openCodeDbPath } from "./opencode-sqlite-source.js";

test("a claude-code-jsonl descriptor resolves to a reader over that path", () => {
  const resolved = resolveTranscriptSource({ kind: "claude-code-jsonl", values: { path: "/tmp/x.jsonl" } });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.ok && resolved.source.kind, "claude-code-jsonl");
});

test("an opencode-sqlite descriptor resolves, and is registered by importing the module", () => {
  // The registration is a side effect of `transcript.ts` importing the
  // OpenCode module. If that import is ever tidied away as unused, OpenCode
  // capture stops working and nothing else fails -- so assert it here.
  const resolved = resolveTranscriptSource({ kind: "opencode-sqlite", values: { sessionId: "ses_1" } });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.ok && resolved.source.kind, "opencode-sqlite");
});

test("an unknown kind is reported, and names what it does know", () => {
  const resolved = resolveTranscriptSource({ kind: "emacs-org-mode", values: {} });

  assert.equal(resolved.ok, false);
  if (resolved.ok) return;
  assert.match(resolved.problem.reason, /no transcript source is registered/);
  // The known list is in the message on purpose: whoever reads this is
  // looking at an adapter whose source they cannot see.
  assert.match(resolved.problem.reason, /claude-code-jsonl/);
  assert.match(resolved.problem.reason, /opencode-sqlite/);
});

test("a missing required value is reported by name", () => {
  const resolved = resolveTranscriptSource({ kind: "opencode-sqlite", values: { xdgDataHome: "/data" } });

  assert.equal(resolved.ok, false);
  assert.equal(resolved.ok === false && resolved.problem.reason, "missing value(s): sessionId");
});

test("an empty required value counts as missing, not as a value", () => {
  // `values.sessionId = ""` is what a harness that lost track of its session
  // sends. Reading every session in a shared database is the alternative.
  const resolved = resolveTranscriptSource({ kind: "opencode-sqlite", values: { sessionId: "" } });

  assert.equal(resolved.ok, false);
  assert.equal(resolved.ok === false && resolved.problem.reason, "missing value(s): sessionId");
});

test("a builder that throws degrades to a reported problem, not an exception", () => {
  registerTranscriptSource("explodes", [], () => {
    throw new Error("constructor blew up");
  });

  const resolved = resolveTranscriptSource({ kind: "explodes", values: {} });

  assert.equal(resolved.ok, false);
  assert.equal(resolved.ok === false && resolved.problem.reason, "constructor blew up");
});

test("sourceIdentity keeps a Claude Code session's existing watermark valid", () => {
  // The identity for claude-code-jsonl *is* the bare path, which is exactly
  // what pre-descriptor state files stored under `transcriptPath`. If this
  // ever changes, every session in flight at upgrade time re-captures from
  // its first entry and re-uploads the whole thing.
  assert.equal(sourceIdentity({ kind: "claude-code-jsonl", values: { path: "/home/me/t.jsonl" } }), "/home/me/t.jsonl");
});

test("sourceIdentity distinguishes two OpenCode sessions and is order-stable", () => {
  const a = sourceIdentity({ kind: "opencode-sqlite", values: { sessionId: "ses_a", xdgDataHome: "/d" } });
  const b = sourceIdentity({ kind: "opencode-sqlite", values: { sessionId: "ses_b", xdgDataHome: "/d" } });
  assert.notEqual(a, b, "two sessions in one database must not share a watermark");

  const reordered = sourceIdentity({ kind: "opencode-sqlite", values: { xdgDataHome: "/d", sessionId: "ses_a" } });
  assert.equal(a, reordered, "key order is an accident of construction, not a different source");
});

test("openCodeDbPath honours XDG_DATA_HOME, which is why it is passed rather than read", () => {
  assert.equal(openCodeDbPath("/custom/data"), path.join("/custom/data", "opencode", "opencode.db"));
  assert.equal(openCodeDbPath(), path.join(os.homedir(), ".local", "share", "opencode", "opencode.db"));
  assert.equal(openCodeDbPath("  "), path.join(os.homedir(), ".local", "share", "opencode", "opencode.db"), "blank is not a data home");
});

test("capture reports an unresolvable source instead of quietly capturing nothing", async () => {
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "twing-cap-"));

  const result = await captureSession({
    sessionId: "s1",
    sessionsDir,
    sourceDescriptor: { kind: "nonexistent-harness", values: {} },
  });

  assert.equal(result.skipped, "unresolved-source");
  assert.match(result.problem ?? "", /no transcript source is registered/);
  assert.equal(result.turnsWritten, 0);
});

test("a legacy transcriptPath with no descriptor is still read as Claude Code", async () => {
  // An older hook binary sends only the path. Version recovery updates hooks
  // on their own schedule, so a new daemon talks to an old hook for a while;
  // if that combination stopped capturing, it would do so silently.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twing-legacy-"));
  const transcript = path.join(dir, "t.jsonl");
  fs.writeFileSync(transcript, "");

  const result = await captureSession({
    sessionId: "s-legacy",
    sessionsDir: dir,
    transcriptPath: transcript,
  });

  assert.notEqual(result.skipped, "unresolved-source", "a bare path must still resolve");
  assert.notEqual(result.skipped, "no-transcript-path");
});

test("neither a descriptor nor a path is the ordinary no-capture case, not a problem", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twing-none-"));

  const result = await captureSession({ sessionId: "s-none", sessionsDir: dir });

  assert.equal(result.skipped, "no-transcript-path");
  assert.equal(result.problem, undefined, "a harness that says nothing is silent on purpose, not broken");
});
