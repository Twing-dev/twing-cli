import { test } from "node:test";
import assert from "node:assert/strict";
import { mayPrintNewToken, announceNewToken } from "./new-token-output.js";
import { captureConsole } from "./test-support.js";

/** process.stdout.isTTY for the length of one call. It is a plain property
 * on the stream, not a getter, so this is a straight swap-and-restore. */
function withTTY<T>(isTTY: boolean | undefined, fn: () => T): T {
  const original = process.stdout.isTTY;
  Object.defineProperty(process.stdout, "isTTY", { value: isTTY, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process.stdout, "isTTY", { value: original, configurable: true });
  }
}

test("mayPrintNewToken: only in front of a human", () => {
  assert.equal(
    withTTY(true, () => mayPrintNewToken(false)),
    true,
    "a terminal, nobody claiming otherwise",
  );
  assert.equal(
    withTTY(true, () => mayPrintNewToken(true)),
    false,
    "unattended is the caller saying no human is here, whatever the stream looks like",
  );
  assert.equal(
    withTTY(undefined, () => mayPrintNewToken(false)),
    false,
    "redirected: a pipe, a log file, a CI job -- the leak this exists to stop",
  );
});

test("announceNewToken: prints the token to a terminal", async () => {
  const { logs } = await captureConsole(async () => withTTY(true, () => announceNewToken("twing join", "secret-pat-value")));
  const output = logs.join("\n");
  assert.match(output, /secret-pat-value/);
  assert.match(output, /only time it will be shown/);
});

test("announceNewToken: never prints the token into a redirected stream, and says why", async () => {
  // The actual incident: `init --unattended` is run by the committed
  // bootstrap hook and by twing-resolve with stdout redirected into
  // ~/.twing/bootstrap.log, so four live PATs were written to a plaintext
  // file over three days (2026-09-14 .. 2026-09-17), one per install.
  const { logs } = await captureConsole(async () => withTTY(undefined, () => announceNewToken("twing join", "secret-pat-value")));
  const output = logs.join("\n");
  assert.doesNotMatch(output, /secret-pat-value/, "the whole point");
  assert.match(output, /whoami --show-token/, "must say how to get it back");
  assert.match(output, /config\.json/, "and that it is not lost");
});

test("announceNewToken: unattended suppresses it even on a terminal", async () => {
  const { logs } = await captureConsole(async () => withTTY(true, () => announceNewToken("twing keygen", "secret-pat-value", true)));
  assert.doesNotMatch(logs.join("\n"), /secret-pat-value/);
});
