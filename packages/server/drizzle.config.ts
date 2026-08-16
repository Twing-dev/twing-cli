import type { Config } from "drizzle-kit";

// Generates migrations for the SQLite schema only (`db/client.ts`'s shipped
// driver). A parallel pg-core schema + config gets added alongside this one
// if/when the Postgres driver is actually built -- see db/client.ts's header
// comment for that seam.
export default {
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
} satisfies Config;
