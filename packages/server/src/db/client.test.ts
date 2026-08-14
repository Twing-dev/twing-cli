import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createDb } from "./client.js";
import { organizations } from "./schema.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "twing-db-client-test-"));
}

test("createDb: produces a working handle backed by a real file under dataDir", () => {
  const dataDir = tmpDir();
  const db = createDb({ dataDir });
  db.insert(organizations).values({ id: "org-1", name: "Acme", createdAt: Date.now() }).run();
  const rows = db.select().from(organizations).all();
  assert.equal(rows.length, 1);
  assert.ok(fs.existsSync(path.join(dataDir, "twing.db")), "should create twing.db in dataDir");
});

test("createDb: calling it twice against the same file is idempotent -- migrations don't double-apply", () => {
  const dataDir = tmpDir();
  const db1 = createDb({ dataDir });
  db1.insert(organizations).values({ id: "org-1", name: "Acme", createdAt: Date.now() }).run();

  // A second createDb() against the same dataDir re-runs the migrator; it
  // must not fail (e.g. "table already exists") and must see the first
  // instance's data.
  const db2 = createDb({ dataDir });
  const rows = db2.select().from(organizations).all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Acme");
});

test("createDb: memory option works without touching the filesystem", () => {
  const db = createDb({ memory: true });
  db.insert(organizations).values({ id: "org-1", name: "Acme", createdAt: Date.now() }).run();
  assert.equal(db.select().from(organizations).all().length, 1);
});

test("createDb: TWING_DB_DRIVER=postgres throws a clear not-yet-implemented error, not a silent fallback", () => {
  process.env.TWING_DB_DRIVER = "postgres";
  try {
    assert.throws(() => createDb({ memory: true }), /not yet implemented/);
  } finally {
    delete process.env.TWING_DB_DRIVER;
  }
});
