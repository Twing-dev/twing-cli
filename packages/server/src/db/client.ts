/**
 * Drizzle client + driver seam (statefulness redesign, 2026-08). `createDb`
 * is the one place a driver gets chosen -- every store class in this
 * package only ever touches the dialect-agnostic query builder returned
 * here, never a driver-specific API, so adding a Postgres branch later
 * doesn't touch a single store.
 *
 * TWING_DB_DRIVER=sqlite (default) is the only driver actually implemented
 * and shipped right now -- matches every real deployment of this project to
 * date (local `twing serve`). TWING_DB_DRIVER=postgres is the documented
 * seam for a future more-scalable/durable multi-tenant backend; asking for
 * it throws rather than silently falling back to SQLite, so a
 * misconfiguration is loud, not a silent downgrade.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";

export type Db = BetterSQLite3Database<typeof schema>;

export interface CreateDbOptions {
  dataDir?: string;
  /** Test-only escape hatch: an in-memory DB instead of a file under
   * dataDir. Real `twing serve` never sets this -- the whole point of this
   * rewrite is surviving a restart, which an in-memory DB can't do. */
  memory?: boolean;
}

/** Migrations are generated once via `drizzle-kit generate` and committed
 * under `drizzle/`, a sibling of both `src/` and `dist/` at the package
 * root -- resolving relative to this module's own location means it works
 * identically whether running from source or compiled output, with no
 * separate copy-migrations build step. */
function migrationsFolder(): string {
  const here = path.dirname(fileURLToPath(import.meta.url)); // .../db, either src or dist
  return path.join(here, "..", "..", "drizzle");
}

export function createDb(options: CreateDbOptions = {}): Db {
  const driver = process.env.TWING_DB_DRIVER ?? "sqlite";
  if (driver !== "sqlite") {
    throw new Error(
      `twing serve: TWING_DB_DRIVER=${driver} is not yet implemented -- only "sqlite" is shipped today. ` +
        "See packages/server/src/db/client.ts for the driver seam this will plug into.",
    );
  }

  let sqlite: Database.Database;
  if (options.memory) {
    sqlite = new Database(":memory:");
  } else {
    const dataDir = options.dataDir ?? path.join(os.homedir(), ".twing", "serve-data");
    fs.mkdirSync(dataDir, { recursive: true });
    sqlite = new Database(path.join(dataDir, "twing.db"));
  }
  sqlite.pragma("journal_mode = WAL");

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: migrationsFolder() });
  return db;
}
