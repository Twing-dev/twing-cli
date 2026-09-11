/**
 * `twing-command.ts` -- making the CLI's own hints runnable.
 *
 * The rule under test is narrow on purpose: rewrite backticked commands,
 * never the `twing <subcommand>:` log prefixes this package uses
 * everywhere. Porting the Go side's "match twing <sub> anywhere" rule would
 * have mangled every prefix, so the prefix cases below are the ones that
 * actually keep this honest.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveTwingHints, twingCommandName } from "./twing-command.js";
import { withHome } from "./test-support.js";

/** A $HOME with the bootstrap shim, and a PATH with no twing -- the shape
 * of a machine onboarded by the committed hook, which avoids npm -g. */
async function onBootstrapMachine<T>(run: (shim: string) => Promise<T> | T): Promise<T> {
  return withHome(async (home) => {
    const shim = path.join(home, ".twing", "bin", "twing");
    fs.mkdirSync(path.dirname(shim), { recursive: true });
    fs.writeFileSync(shim, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), "twing-nopath-"));
    const originalPath = process.env.PATH;
    process.env.PATH = emptyBin;
    try {
      return await run(shim);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });
}

test("resolveTwingHints: rewrites a backticked command when twing isn't on PATH", async () => {
  await onBootstrapMachine((shim) => {
    const out = resolveTwingHints("unauthorized -- run `twing login` to re-authenticate");
    assert.equal(out, `unauthorized -- run \`${shim} login\` to re-authenticate`);
  });
});

test("resolveTwingHints: leaves the `twing <sub>:` log prefix alone", async () => {
  await onBootstrapMachine(() => {
    // The reason this can't reuse the Go rule. These are prefixes, not
    // commands, and rewriting them produces nonsense.
    for (const prefix of [
      "twing align: no coordinator configured for this repo",
      "twing admin revoke-developer: removed",
      "twing design: none of the declared --touches files exist",
      "twing init: daemon started",
    ]) {
      assert.equal(resolveTwingHints(prefix), prefix, `prefix must survive: ${prefix}`);
    }
  });
});

test("resolveTwingHints: rewrites the command but not the prefix in the same line", async () => {
  await onBootstrapMachine((shim) => {
    const out = resolveTwingHints("twing design: no coordinator configured -- run `twing init --server <url>` once");
    assert.ok(out.startsWith("twing design: no coordinator"), `prefix was rewritten: ${out}`);
    assert.ok(out.includes(`\`${shim} init --server <url>\``), `command was not rewritten: ${out}`);
  });
});

test("resolveTwingHints: leaves other backticked content alone", async () => {
  await onBootstrapMachine(() => {
    for (const text of [
      "(`gh auth login`), then retry",
      "run `npm install -g @twing/cli@latest` first",
      "see `~/.twing/config.json` for cached tokens",
      "`twing serve` names the coordination server, not a local command",
    ]) {
      assert.equal(resolveTwingHints(text), text, `must not rewrite: ${text}`);
    }
  });
});

test("resolveTwingHints: keeps the bare name when twing resolves on PATH", async () => {
  await withHome(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twing-onpath-"));
    fs.writeFileSync(path.join(dir, "twing"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const originalPath = process.env.PATH;
    process.env.PATH = `${dir}:${originalPath ?? ""}`;
    try {
      assert.equal(twingCommandName(), "twing", "the bare name is what a reader expects, and would type");
      const text = "unauthorized -- run `twing login` to re-authenticate";
      assert.equal(resolveTwingHints(text), text);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });
});

test("resolveTwingHints: resolves freshly, so a mid-session global install takes effect at once", async () => {
  // Nothing is cached: every CLI run is a fresh process, and even within
  // one, installing twing must be picked up with no invalidation step.
  await onBootstrapMachine(async (shim) => {
    assert.equal(twingCommandName(), shim);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twing-lateinstall-"));
    fs.writeFileSync(path.join(dir, "twing"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;

    assert.equal(twingCommandName(), "twing", "a global install must take effect immediately");
  });
});
