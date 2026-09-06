/**
 * `applyDefault` (prompt-line.ts) -- the one piece of `promptLine` that's
 * pure and testable without faking a TTY. `promptLine` itself reads
 * directly from `process.stdin`/`process.stdout` with no injectable seam
 * (same as `prompt-password.ts`), so its interactive-read path isn't
 * covered here, matching this codebase's existing convention for both
 * prompt functions.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDefault } from "./prompt-line.js";

test("applyDefault: a bare Enter (empty string) falls back to defaultValue", () => {
  assert.equal(applyDefault("", "https://coordination-server.twing.dev"), "https://coordination-server.twing.dev");
});

test("applyDefault: a real answer is returned as-is, ignoring defaultValue", () => {
  assert.equal(applyDefault("https://my-own-server.example.com", "https://coordination-server.twing.dev"), "https://my-own-server.example.com");
});

test("applyDefault: an empty answer with no defaultValue given stays empty", () => {
  assert.equal(applyDefault(""), "");
});
