/**
 * `repo-setup.ts`'s generators are the single source both `enforce-hooks.ts`
 * (local disk) and the GitHub App Setup URL route (`packages/server`,
 * Contents API) write from -- this file just confirms the pure pieces do
 * what their callers assume, in isolation from either write path.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bootstrapHookScript,
  hasBootstrapHookWired,
  mergeBootstrapHookEntries,
  removeBootstrapHookEntries,
  WIRED_HOOK_EVENTS,
  BOOTSTRAP_HOOK_MARKER,
} from "./repo-setup.js";
import type { ClaudeSettings } from "./claude-settings.js";

test("bootstrapHookScript: deterministic -- two calls produce byte-identical output", () => {
  assert.equal(bootstrapHookScript(), bootstrapHookScript());
});

test("bootstrapHookScript: carries the current marker", () => {
  assert.ok(bootstrapHookScript().includes(BOOTSTRAP_HOOK_MARKER));
});

test("mergeBootstrapHookEntries: wires every event in WIRED_HOOK_EVENTS into an empty settings object", () => {
  const settings: ClaudeSettings = {};
  const changed = mergeBootstrapHookEntries(settings);
  assert.equal(changed, true);
  assert.equal(hasBootstrapHookWired(settings), true);
  for (const { event } of WIRED_HOOK_EVENTS) {
    assert.ok(settings.hooks?.[event], `expected ${event} to be wired`);
  }
});

test("mergeBootstrapHookEntries: idempotent -- a second call reports no change", () => {
  const settings: ClaudeSettings = {};
  mergeBootstrapHookEntries(settings);
  const changedAgain = mergeBootstrapHookEntries(settings);
  assert.equal(changedAgain, false);
});

test("mergeBootstrapHookEntries: preserves a sibling tool's hook under the same matcher", () => {
  const settings: ClaudeSettings = {
    hooks: {
      PreToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "some-other-tool-hook" }] }],
    },
  };
  mergeBootstrapHookEntries(settings);
  const entry = settings.hooks?.PreToolUse?.find((e) => e.matcher === "Edit|Write");
  assert.ok(entry?.hooks.some((h) => h.command === "some-other-tool-hook"));
  assert.ok(entry && entry.hooks.length > 1);
});

test("removeBootstrapHookEntries: removes what mergeBootstrapHookEntries added, sparing siblings", () => {
  const settings: ClaudeSettings = {
    hooks: {
      PreToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "some-other-tool-hook" }] }],
    },
  };
  mergeBootstrapHookEntries(settings);
  const removed = removeBootstrapHookEntries(settings);
  assert.equal(removed, true);
  assert.equal(hasBootstrapHookWired(settings), false);
  const entry = settings.hooks?.PreToolUse?.find((e) => e.matcher === "Edit|Write");
  assert.ok(entry?.hooks.some((h) => h.command === "some-other-tool-hook"));
});
