/**
 * Ensures `twing-hook` is present (§6 step 2) — "fetch a prebuilt release
 * for the platform, or build from source if a Go toolchain is available."
 * No releases are published yet (pre-v0, dogfood-only), so this only
 * implements the build-from-source path — an intentional, doc-sanctioned
 * scope cut, not a placeholder for the release-fetch path.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

export function hookBinaryPath(): string {
  const ext = process.platform === "win32" ? ".exe" : "";
  return path.join(os.homedir(), ".twing", "bin", `twing-hook${ext}`);
}

/** Walks up from this module's own install location looking for a `hook/`
 * Go module directory — the monorepo dev-mode layout. Real distribution
 * would need the hook source bundled into the published package; not built
 * here since there's nothing to distribute to yet. */
function findHookSource(): string | null {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "hook");
    if (fs.existsSync(path.join(candidate, "go.mod"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function goAvailable(): boolean {
  try {
    execFileSync("go", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Returns the installed binary path, building from source when possible.
 * Throws only when there's neither a fresh build nor a previously installed
 * binary to fall back to. */
export function ensureHookInstalled(): string {
  const target = hookBinaryPath();
  const source = findHookSource();

  if (source && goAvailable()) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    execFileSync("go", ["build", "-o", target, "."], { cwd: source, stdio: "inherit" });
    return target;
  }

  if (fs.existsSync(target)) {
    return target; // reuse whatever's already installed
  }

  throw new Error(
    source
      ? "twing init: found hook source but no Go toolchain (`go` not on PATH) -- install Go, or place a prebuilt twing-hook binary at " + target
      : "twing init: could not locate twing-hook source (expected a hook/go.mod ancestor) and no binary is already installed at " + target,
  );
}
