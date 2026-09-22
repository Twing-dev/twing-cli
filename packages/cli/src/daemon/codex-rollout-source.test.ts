/**
 * Codex rollout translation: which records become conversation, which carry
 * only paths, and which never leave the machine at all.
 *
 * The fixtures here are real records, trimmed of their bulk -- captured from a
 * codex-cli 0.114 session driven against a stub model provider. The shapes
 * that matter (the `session_meta` header, `response_item` wrapping a Responses
 * `message`, a `custom_tool_call` carrying an `apply_patch` envelope) are as
 * Codex writes them.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { filterTranscriptEntry, reposForEntry } from "@twing/core";
import { CodexRolloutSource, translateRolloutItem } from "./codex-rollout-source.js";

const SESSION_CWD = "/home/dev/proj";

function rolloutFile(lines: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twing-codex-rollout-"));
  const file = path.join(dir, "rollout-2026-09-20T20-14-42-01a0c1f5.jsonl");
  fs.writeFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
  return file;
}

function sessionMeta(cwd = SESSION_CWD): unknown {
  return {
    timestamp: "2026-09-21T03:13:07.390Z",
    ordinal: 0,
    type: "session_meta",
    payload: { session_id: "01a0c1f5-7088-78b3-9b5c-18523f13a6d8", cwd, originator: "codex_cli_rs" },
  };
}

function message(role: string, text: string, timestamp = "2026-09-21T03:13:08.000Z"): unknown {
  const kind = role === "assistant" ? "output_text" : "input_text";
  return {
    timestamp,
    type: "response_item",
    payload: { type: "message", id: `msg_${role}`, role, content: [{ type: kind, text }] },
  };
}

async function readAll(file: string): Promise<unknown[]> {
  const source = new CodexRolloutSource(file);
  const values: unknown[] = [];
  await source.read(source.beginning, ({ value }) => void values.push(value));
  return values;
}

/** What the capture pipeline would keep from a translated entry. */
function captured(value: unknown): { role?: string; text?: string; paths: string[] } {
  const filtered = filterTranscriptEntry(value);
  return { role: filtered.turn?.role, text: filtered.turn?.text, paths: filtered.paths };
}

test("human turns and assistant prose survive translation into the capture filter", async () => {
  const file = rolloutFile([
    sessionMeta(),
    message("user", "make retries exponential"),
    message("assistant", "Switched RetryPolicy.backoff to exponential with jitter."),
  ]);

  const kept = (await readAll(file)).map(captured);

  assert.deepEqual(
    kept.map((k) => [k.role, k.text]),
    [
      ["user", "make retries exponential"],
      ["assistant", "Switched RetryPolicy.backoff to exponential with jitter."],
    ],
  );
});

test("Codex's own injected turns are dropped, though what they name is not", async () => {
  // All three arrive as `role: "user"` or `role: "developer"` messages,
  // indistinguishable from a human turn by role alone -- which is the whole
  // reason translation marks them rather than leaving it to the filter.
  const file = rolloutFile([
    sessionMeta(),
    // The real 0.155 shape: several wrappers concatenated into one message,
    // with a newer one (`<recommended_plugins>`) ahead of the rest.
    message(
      "user",
      "<recommended_plugins>\n- Slack (slack@openai-curated-remote)\n</recommended_plugins>\n" +
        "<environment_context>\n  <cwd>/home/dev/proj</cwd>\n</environment_context>",
    ),
    message("developer", "<skills_instructions>\n## Skills\n</skills_instructions>"),
    // Where a hook's additionalContext lands -- twing's own notices included.
    message("developer", "twing: someone else changed src/net/retry.ts 20 minutes ago"),
    message("user", "ok, go ahead"),
  ]);

  const kept = (await readAll(file)).map(captured).filter((k) => k.text !== undefined);

  assert.deepEqual(kept.map((k) => k.text), ["ok, go ahead"]);
});

test("an apply_patch call contributes the files it touches and nothing else", async () => {
  const file = rolloutFile([
    sessionMeta(),
    {
      timestamp: "2026-09-21T03:13:09.000Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        call_id: "call_1",
        name: "apply_patch",
        input: "*** Begin Patch\n*** Update File: src/net/retry.ts\n@@\n-old\n+new\n*** Add File: docs/retry.md\n+# Retry\n*** End Patch\n",
      },
    },
  ]);

  const kept = (await readAll(file)).map(captured);

  assert.equal(kept.length, 1);
  assert.equal(kept[0].text, undefined, "a tool call is not conversation");
  assert.deepEqual(
    kept[0].paths.filter((p) => p !== SESSION_CWD),
    [`${SESSION_CWD}/src/net/retry.ts`, `${SESSION_CWD}/docs/retry.md`],
    "every file in the patch, resolved against the session's directory -- see the note on the projectId pass",
  );
});

test("a patch's relative paths resolve to the repo, even resuming mid-file", async () => {
  // The consent boundary is computed from repos, and a Codex patch names its
  // files relative to the session's directory. A pass that resumes after the
  // header would otherwise resolve none of them -- which reads as "this
  // session touched nothing" and captures nothing at all.
  const file = rolloutFile([
    sessionMeta(),
    message("user", "first"),
    {
      timestamp: "2026-09-21T03:13:09.000Z",
      type: "response_item",
      payload: { type: "custom_tool_call", name: "apply_patch", input: "*** Update File: src/a.ts\n+x\n" },
    },
  ]);

  // Stop after the first turn, so the resumed pass starts *below* the
  // header line that carries the session's directory.
  const source = new CodexRolloutSource(file);
  let afterFirstTurn: string | undefined;
  await source.read(source.beginning, ({ after }) => {
    afterFirstTurn ??= after;
  });
  assert.ok(afterFirstTurn, "the first turn produced a cursor");

  const resumed = new CodexRolloutSource(file);
  const values: unknown[] = [];
  await resumed.read(await resumed.resume(afterFirstTurn), ({ value }) => void values.push(value));

  const patch = values.map((v) => filterTranscriptEntry(v)).find((f) => f.paths.some((p) => p.endsWith("src/a.ts")));
  assert.ok(patch, "the patch entry arrived");
  assert.deepEqual(reposForEntry(patch, (p) => (p.startsWith(SESSION_CWD) ? SESSION_CWD : undefined)), [SESSION_CWD]);
});

test("reasoning, tool output and bookkeeping records never leave the machine", async () => {
  const file = rolloutFile([
    sessionMeta(),
    { timestamp: "t", type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "private chain of thought" }] } },
    { timestamp: "t", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call_1", output: "Success. Updated the following files:\nM a.txt" } },
    { timestamp: "t", type: "response_item", payload: { type: "function_call_output", call_id: "call_2", output: "secret-looking command output" } },
    // The UI's duplicate of every item: capturing it would double every turn.
    { timestamp: "t", type: "event_msg", payload: { type: "item_completed", item: { type: "AgentMessage", text: "done" } } },
    { timestamp: "t", type: "token_usage_record", payload: { total_tokens: 2 } },
    { timestamp: "t", type: "world_state", payload: { full: true, state: {} } },
  ]);

  const values = await readAll(file);

  assert.deepEqual(values, [], "nothing here is conversation");
});

test("a human turn carrying an injected block keeps the human's words, not the block", () => {
  // The same rule `transcript-filter.ts` applies to `<system-reminder>`:
  // strip the wrapper, keep what the person actually wrote.
  const translated = translateRolloutItem(
    {
      timestamp: "t",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "<environment_context>\n  <cwd>/home/dev/proj</cwd>\n</environment_context>\nfix the retry ceiling" }],
      },
    },
    SESSION_CWD,
  );

  assert.equal(captured(translated).text, "fix the retry ceiling");
});

test("a patch path is absolute, so it cannot be resolved against the daemon's own cwd", () => {
  // Found live: the daemon serves every repo on the machine, and
  // `transcript.ts`'s projectId pass sees only the bare path -- so a relative
  // one there resolved against whatever directory the daemon was started in,
  // labelling a session with a completely unrelated repo's projectId.
  const translated = translateRolloutItem(
    { timestamp: "t", type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", input: "*** Update File: src/a.ts\n+x\n" } },
    SESSION_CWD,
  );

  assert.deepEqual(captured(translated).paths.filter((p) => p !== SESSION_CWD), [`${SESSION_CWD}/src/a.ts`]);
});

test("code mode: a patch inside a JavaScript string literal still names its files", () => {
  // Codex's newer models (gpt-6-astra on 0.155, `tool_mode: code_mode_only`)
  // don't emit one tool call per action -- they write JS, and the rollout
  // records the source. The patch is all there, but its newlines are escaped,
  // so a line-oriented parser sees one long line and finds nothing. Verbatim
  // from a real session; the edit it describes went entirely unattributed
  // until this was handled.
  const translated = translateRolloutItem(
    {
      timestamp: "t",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        input:
          'text(await tools.apply_patch("*** Begin Patch\\n*** Update File: /home/dev/proj/src/retry.ts\\n@@\\n' +
          '+  jitter(delay: number): number {\\n*** End Patch"));\n' +
          'text(await tools.exec_command({cmd:"git diff --check","workdir":"/home/dev/proj"}));',
      },
    },
    SESSION_CWD,
  );

  assert.ok(translated, "the call should translate");
  assert.deepEqual(
    captured(translated).paths.filter((p) => p !== SESSION_CWD),
    ["/home/dev/proj/src/retry.ts"],
    "the patch's target, and nothing mined out of the surrounding JavaScript",
  );
});

test("a shell command is not mined for paths", () => {
  // Same contract as Claude's Bash and OpenCode's bash: a command line can
  // contain anything, and guessing at it would smuggle tool content back in
  // through the one field the capture contract says is kept.
  const translated = translateRolloutItem(
    { timestamp: "t", type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "sed -i s/a/b/ src/secret.ts"] }) } },
    SESSION_CWD,
  );

  assert.equal(translated, undefined);
});

test("a tool that does name a path in its arguments contributes it", () => {
  const translated = translateRolloutItem(
    { timestamp: "t", type: "response_item", payload: { type: "function_call", name: "view_image", arguments: JSON.stringify({ path: "/home/dev/proj/diagram.png" }) } },
    SESSION_CWD,
  );

  assert.deepEqual(captured(translated).paths.filter((p) => p !== SESSION_CWD), ["/home/dev/proj/diagram.png"]);
});

test("a rollout that is gone, or is not a rollout, degrades to nothing captured", async () => {
  const missing = new CodexRolloutSource("/no/such/rollout.jsonl");
  assert.equal(await missing.exists(), false);
  assert.deepEqual(await readAll("/no/such/rollout.jsonl"), []);

  // A file whose first line is not JSON: no session cwd, and no crash.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twing-codex-junk-"));
  const junk = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(junk, "not json at all\n");
  assert.deepEqual(await readAll(junk), []);
});

test("a session that moved keeps its new directory across capture passes", async () => {
  // `turn_context` declares the working directory a turn runs in, and a patch
  // names its files relative to it. A later pass resumes *below* that record
  // -- the source is rebuilt every pass, so nothing in memory survives -- and
  // would otherwise fall back to the header's directory and attribute the
  // edit to the wrong repo, or to none.
  const moved = "/home/dev/other-project";
  const file = rolloutFile([
    sessionMeta(),
    message("user", "first, here"),
    { timestamp: "t", type: "turn_context", payload: { cwd: moved } },
    message("user", "now somewhere else"),
    {
      timestamp: "t",
      type: "response_item",
      payload: { type: "custom_tool_call", name: "apply_patch", input: "*** Update File: src/moved.ts\n+x\n" },
    },
  ]);

  // Pass one stops after the turn that follows the move, so the `turn_context`
  // is consumed and the patch is not.
  const first = new CodexRolloutSource(file);
  let cursor = first.beginning;
  let seen = 0;
  await first.read(first.beginning, ({ after }) => {
    seen += 1;
    if (seen <= 2) cursor = after;
  });

  // Pass two: a brand new source, resuming from what pass one stored.
  const second = new CodexRolloutSource(file);
  const values: unknown[] = [];
  await second.read(await second.resume(cursor), ({ value }) => void values.push(value));

  const patch = values.map((v) => filterTranscriptEntry(v)).find((f) => f.paths.some((p) => p.endsWith("moved.ts")));
  assert.ok(patch, "the patch entry arrived");
  assert.deepEqual(
    patch.paths.filter((p) => p.endsWith("moved.ts")),
    [`${moved}/src/moved.ts`],
    "resolved against where the session had moved to, not where it started",
  );
});

test("a cursor stored before it carried a directory still resumes", async () => {
  // State files written by the version that shipped first hold a bare byte
  // cursor. Misreading one would re-read the whole transcript and re-capture
  // a session that was already captured.
  const file = rolloutFile([sessionMeta(), message("user", "one"), message("assistant", "two")]);
  const source = new CodexRolloutSource(file);

  let bare: string | undefined;
  await source.read(source.beginning, ({ after }) => {
    // What the old encoding stored: the inner byte cursor alone.
    bare ??= after.replace(/^codex1\|/, "").split("|")[0];
  });

  const resumed = new CodexRolloutSource(file);
  const values: unknown[] = [];
  await resumed.read(await resumed.resume(bare), ({ value }) => void values.push(value));

  assert.deepEqual(values.map((v) => filterTranscriptEntry(v).turn?.text), ["two"], "picks up after the first turn, not from zero");
});
