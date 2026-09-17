import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

test("workspace postinstall never rewrites a contributor's home configuration", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "twing-postinstall-test-"));
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  try {
    execFileSync(process.execPath, [path.join(packageRoot, "postinstall.cjs")], {
      env: { ...process.env, HOME: home },
      stdio: "pipe",
    });
    assert.equal(fs.existsSync(path.join(home, ".claude")), false);
    assert.equal(fs.existsSync(path.join(home, ".config", "opencode")), false);
    assert.equal(fs.existsSync(path.join(home, ".twing")), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
