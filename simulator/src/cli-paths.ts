import { createRequire } from "node:module";
import * as path from "node:path";

const require = createRequire(import.meta.url);

export function cliEntryPath(): string {
  const pkgJsonPath = require.resolve("@twing/cli/package.json");
  return path.join(path.dirname(pkgJsonPath), "dist", "index.js");
}

export function serverEntryPath(): string {
  const pkgJsonPath = require.resolve("@twing/server/package.json");
  return path.join(path.dirname(pkgJsonPath), "dist", "main.js");
}
