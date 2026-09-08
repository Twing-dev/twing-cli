/**
 * Ensures `twing-hook` is present (§6 step 2) — "fetch a prebuilt release
 * for the platform, or build from source if a Go toolchain is available."
 * Priority order, and why: (1) local hook source + Go toolchain wins first
 * -- a twing-cli contributor's own checkout may have uncommitted hook
 * changes; silently fetching a released binary instead would ignore them.
 * (2) a prebuilt release fetch for everyone else -- the common case, no Go
 * toolchain needed. (3) reuse whatever's already installed. (4) throw.
 * Was pre-v0 dogfood-only build-from-source-only until the release
 * pipeline (`.github/workflows/release-hook.yml`) existed to fetch from.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { getCliVersion } from "./version.js";

export function hookBinaryPath(): string {
  const ext = process.platform === "win32" ? ".exe" : "";
  return path.join(os.homedir(), ".twing", "bin", `twing-hook${ext}`);
}

/** Where `ensureCliShim` puts a runnable `twing`, beside the hook binary. */
export function cliShimPath(): string {
  return path.join(os.homedir(), ".twing", "bin", "twing");
}

/**
 * Makes the CLI runnable on a machine onboarded by the committed bootstrap
 * hook.
 *
 * That path deliberately avoids `npm install -g` (it would need sudo on a
 * system-Node box, which a hook has no TTY to supply), so the CLI lands in
 * `~/.twing/lib/node_modules/` with nothing on `PATH` pointing at it --
 * while every remediation message the design gate prints says to run
 * `twing design register ...`. The result was a gate that blocks correctly
 * and then names a command that does not exist: strictly worse than no
 * gate, because there is no way forward. Found live.
 *
 * A small wrapper here fixes that without touching `PATH` or anyone's
 * shell rc (neither of which could help the already-running session
 * anyway) -- the gate points at this absolute path when a bare `twing`
 * isn't resolvable (`resolveTwingCommand`, hook/design_gate.go). It lives
 * beside `twing-hook`, in a directory twing already owns, so `twing
 * uninstall` reclaims it for free.
 *
 * Harmless for a global install, which already has a real `twing` on
 * `PATH` and will simply keep using it. Never throws -- a machine where
 * this can't be written still has a working gate, just a less convenient
 * one.
 */
export function ensureCliShim(): string | null {
  // Windows has no equivalent of this shim, and the committed bootstrap
  // hook that makes it necessary is POSIX-only anyway (documented gap).
  if (process.platform === "win32") return null;

  // dist/install-hook.js -> dist/index.js: this build's own entrypoint,
  // whichever copy is running.
  const cliEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");
  const shim = cliShimPath();
  try {
    if (!fs.existsSync(cliEntry)) return null;
    fs.mkdirSync(path.dirname(shim), { recursive: true });
    // A wrapper rather than a symlink, deliberately: a symlink inherits the
    // target's permissions, and `dist/index.js` is only executable when npm
    // installed the package (it sets the bit for a `bin` entry) -- not in a
    // contributor's checkout, where tsc just writes a plain file. Naming
    // the interpreter explicitly also sidesteps shebang resolution
    // entirely. Same {node, script} shape the daemon launch marker uses.
    fs.writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cliEntry)} "$@"\n`, { mode: 0o755 });
    return shim;
  } catch {
    return null;
  }
}

/** Walks up from this module's own install location looking for a `hook/`
 * Go module directory — the monorepo dev-mode layout, i.e. "this is a
 * twing-cli contributor's own checkout." */
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

const RELEASE_REPO = "Twing-dev/twing-cli";

/** GOOS/GOARCH names, matching `.github/workflows/release-hook.yml`'s
 * asset-naming convention (`twing-hook-<os>-<arch>[.exe]`) -- not Node's
 * own `process.platform`/`process.arch` spelling (`win32`/`x64`). */
export function releaseAssetName(): string | null {
  const osNames: Partial<Record<NodeJS.Platform, string>> = { darwin: "darwin", linux: "linux", win32: "windows" };
  const archNames: Partial<Record<NodeJS.Architecture, string>> = { x64: "amd64", arm64: "arm64" };
  const osName = osNames[process.platform];
  const archName = archNames[process.arch];
  if (!osName || !archName) return null; // unsupported platform/arch -- no asset exists to fetch
  const ext = process.platform === "win32" ? ".exe" : "";
  return `twing-hook-${osName}-${archName}${ext}`;
}

/** Fetches the latest published release's binary for this platform,
 * writing it to `target`. GitHub's `/releases/latest/download/<asset>` URL
 * always redirects to the current latest release's matching asset -- no
 * API token, no rate limit, works from a plain `fetch`. Returns false (never
 * throws) on any failure: no release published yet, wrong platform, a
 * network hiccup -- all fall through to the next tier the same way. */
export async function fetchPrebuiltHook(target: string): Promise<boolean> {
  const asset = releaseAssetName();
  if (!asset) return false;

  const url = `https://github.com/${RELEASE_REPO}/releases/latest/download/${asset}`;
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) return false;
    const bytes = new Uint8Array(await res.arrayBuffer());
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    if (process.platform !== "win32") {
      fs.chmodSync(target, 0o755);
    }
    return true;
  } catch {
    return false;
  }
}

/** Returns the installed binary path -- building from source, fetching a
 * prebuilt release, or reusing an already-installed binary, in that
 * priority order (see the module doc comment for why). Throws only when
 * none of those three produced anything at all. */
export async function ensureHookInstalled(): Promise<string> {
  const target = hookBinaryPath();
  const source = findHookSource();

  if (source && goAvailable()) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // stdio: "inherit" below means `go build`'s own output is the first
    // thing printed -- which can take a real few-to-tens-of-seconds on a
    // cold build cache, with nothing on screen until then. Without this
    // line first, that looks indistinguishable from a hang (found live,
    // 2026-08-17, on a machine with `twing` npm-linked to this checkout).
    console.log(`twing init: building twing-hook from source (found ${source})...`);
    // On macOS, Go's default *internal* linker (used whenever CGO isn't
    // explicitly enabled) doesn't emit the Mach-O LC_UUID load command --
    // harmless on older macOS, but a hard dyld launch failure ("missing
    // LC_UUID load command") on newer ones, found live 2026-08-17 (same bug
    // hit the CI-built prebuilt release binary, fixed the same way in
    // release-hook.yml). Forcing the external linker (via cgo + the
    // system's real `cc`/`ld`) produces a properly-formed binary. Mach-O-only
    // concept -- ELF/PE builds (Linux/Windows) never needed this.
    // -X main.version=... stamps this npm install's own version into the
    // binary (version.go), same as release-hook.yml's release builds do
    // from the git tag -- the §17 gate's version-compatibility check needs
    // a real value here too, not the "dev" fallback, since this is a
    // genuine `@twing/cli` install, just building its hook from source
    // rather than fetching a prebuilt binary.
    const versionLdflag = `-X main.version=${getCliVersion()}`;
    const buildArgs =
      process.platform === "darwin"
        ? ["build", `-ldflags=-linkmode=external ${versionLdflag}`, "-o", target, "."]
        : ["build", `-ldflags=${versionLdflag}`, "-o", target, "."];
    execFileSync("go", buildArgs, { cwd: source, stdio: "inherit", env: { ...process.env, CGO_ENABLED: process.platform === "darwin" ? "1" : process.env.CGO_ENABLED } });
    return target;
  }

  if (await fetchPrebuiltHook(target)) {
    return target;
  }

  if (fs.existsSync(target)) {
    return target; // reuse whatever's already installed
  }

  throw new Error(
    source
      ? "twing init: found hook source but no Go toolchain (`go` not on PATH) -- install Go, or place a prebuilt twing-hook binary at " + target
      : `twing init: could not locate twing-hook source (expected a hook/go.mod ancestor), no prebuilt release could be fetched, and no binary is already installed at ${target}`,
  );
}
