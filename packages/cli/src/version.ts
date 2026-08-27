import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** Reads this package's own `package.json` version directly -- always exactly
 * one directory up from wherever this module itself is running (`dist/` in
 * the built/npm-installed form, `packages/cli/` for its `package.json`),
 * whether that's a global npm install or a contributor's own monorepo
 * checkout. Deliberately not `npm list -g @twing/cli`/similar shell-out:
 * that reports what's installed globally, not what binary is actually
 * executing right now (e.g. `node packages/cli/dist/index.js` against a
 * local build while some other version is npm-installed globally).
 *
 * Shared by index.ts's `--version` output and daemon/sync.ts's version-
 * mismatch check -- one implementation instead of each re-deriving the same
 * relative path independently. */
export function getCliVersion(): string {
  const packageJsonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { version?: string };
  return pkg.version ?? "unknown";
}
