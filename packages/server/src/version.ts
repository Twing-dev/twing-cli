import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** Reads this package's own `package.json` version directly -- same
 * approach as packages/cli/src/index.ts's getVersion(), always exactly one
 * directory up from wherever this module itself is running. This is the
 * version `/v1/version` reports, which the daemon's soft notice and the Go
 * hook's §17 gate check both compare their own version against. */
export function getServerVersion(): string {
  const packageJsonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { version?: string };
  return pkg.version ?? "unknown";
}
