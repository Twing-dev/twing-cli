import * as fs from "node:fs";
import * as path from "node:path";

/** Walks up from `startDir` looking for `.git`. Falls back to `startDir`
 * itself if none is found (e.g. a fully local repo mid-`git init`, or no
 * repo at all) — callers still get a stable, if arbitrary, root. */
export function findRepoRoot(startDir: string): string {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(startDir);
    dir = parent;
  }
}
