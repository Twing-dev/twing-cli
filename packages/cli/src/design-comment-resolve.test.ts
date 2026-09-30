/**
 * `twing design comment reply|resolve` refuse, locally, and say where that
 * happens instead.
 *
 * Review comments are answered and resolved by people in twing-monitor
 * (2026-09-27). The commands are kept rather than deleted so an agent running
 * one from memory or an older README gets that explanation, instead of a bare
 * usage dump that teaches nothing and invites a second attempt.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runDesignCommentVerb } from "./design.js";

function captureStderr(run: () => void): string {
  const original = console.error;
  let output = "";
  console.error = (...args: unknown[]) => {
    output += args.map(String).join(" ") + "\n";
  };
  try {
    run();
  } finally {
    console.error = original;
  }
  return output;
}

for (const verb of ["reply", "resolve"] as const) {
  test(`design comment ${verb}: points at twing-monitor, where people answer comments`, () => {
    const output = captureStderr(() => runDesignCommentVerb(verb));
    assert.match(output, new RegExp(`twing design comment ${verb}:`));
    assert.match(output, /twing-monitor/);
  });

  // A refusal that does not name the alternative is a refusal the caller
  // retries -- and the alternative, for an agent, is its user.
  test(`design comment ${verb}: tells an agent to hand it to its user and carry on`, () => {
    const output = captureStderr(() => runDesignCommentVerb(verb));
    assert.match(output, /tell your user/);
    assert.match(output, /twing design comments/, "and how to read them from here");
  });
}
