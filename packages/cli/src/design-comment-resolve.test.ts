/**
 * `twing design comment resolve` refuses, locally, and says what to do
 * instead.
 *
 * Closing a review comment is the reviewer's call -- they asked the question,
 * so they decide it has been answered. The command is kept rather than
 * deleted so an agent running it from memory or an older README gets that
 * explanation and the command it actually wants, instead of a bare usage
 * dump that teaches nothing and invites a second attempt.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runDesignCommentResolve } from "./design.js";

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

test("design comment resolve: explains that closing is the reviewer's call", () => {
  const output = captureStderr(() => runDesignCommentResolve({ cwd: process.cwd(), commentId: "cm-123" }));
  assert.match(output, /reviewer's call/);
});

// A refusal that does not name the alternative is a refusal the caller
// retries.
test("design comment resolve: hands back the reply command, filled in", () => {
  const output = captureStderr(() => runDesignCommentResolve({ cwd: process.cwd(), commentId: "cm-123" }));
  assert.match(output, /twing design comment reply cm-123 --message/);
});

test("design comment resolve: names amend for a comment that wants a change, not just a reply", () => {
  const output = captureStderr(() => runDesignCommentResolve({ cwd: process.cwd(), commentId: "cm-123" }));
  assert.match(output, /twing design amend/);
});

// It refuses before resolving a repo or a coordinator, so it behaves the same
// wherever it is run -- including outside a repo, where an agent that just
// read the deny is most likely to try it.
test("design comment resolve: refuses without needing a repo, a server or a token", () => {
  const output = captureStderr(() => runDesignCommentResolve({ cwd: "/definitely/not/a/repo", commentId: "cm-123" }));
  assert.match(output, /reviewer's call/);
});

test("design comment resolve: still readable when no comment id was given", () => {
  const output = captureStderr(() => runDesignCommentResolve({ cwd: process.cwd(), commentId: "" }));
  assert.match(output, /twing design comment reply <commentId> --message/);
});
