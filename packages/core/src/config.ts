/**
 * Machine-wide config (§6): `~/.twing/config.json`. A map of coordinator
 * server URLs to per-server auth state -- multiple servers can have cached
 * tokens simultaneously (a developer working across repos pointed at
 * different coordinators), not just one machine-wide slot. Never holds
 * anything from a repo's committed config; `authToken` only ever lands here
 * via `twing login`/`twing keygen --invite`/`twing admin bootstrap` (§17.10
 * hardening) -- a personal access token generated on this machine, never a
 * password.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface ServerAuth {
  /** A personal access token (§17.10 hardening), generated client-side by
   * `twing keygen`/`admin bootstrap` -- the server only ever sees its hash.
   * Absent when this machine hasn't authenticated to that server yet. */
  authToken?: string;
}

export interface TwingConfig {
  servers?: Record<string, ServerAuth>;
}

/** Pre-multi-server shape: one implicit server, keyed by nothing. */
interface LegacyTwingConfig {
  serverUrl?: string;
  authToken?: string;
}

export function configPath(): string {
  return path.join(os.homedir(), ".twing", "config.json");
}

/**
 * `fetch` requires an absolute URL with a scheme -- `--server host:port`
 * (a very natural thing to type) otherwise fails deep inside a network
 * try/catch with a cryptic "failed to parse URL" error that gets silently
 * swallowed as "server unreachable" three layers down (caught live,
 * 2026-08-11). Validate and normalize once, here. Also strips a single
 * trailing slash so equivalent inputs collapse to the same `servers` map
 * key -- serverUrl now doubles as a lookup key, not just a display string,
 * so two spellings of the same server silently forking into two
 * cached-token slots would be a real, confusing bug.
 */
export function normalizeServerUrl(input: string): string {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `http://${input}`;
  try {
    new URL(withScheme);
  } catch {
    throw new Error(`twing: "${input}" isn't a valid server URL (tried "${withScheme}") -- expected something like http://host:port`);
  }
  return withScheme.replace(/\/$/, "");
}

function isLegacyShape(raw: unknown): raw is LegacyTwingConfig {
  return !!raw && typeof raw === "object" && !("servers" in raw) && "serverUrl" in raw;
}

/**
 * Migrates the old single-slot shape (`{serverUrl, authToken}`) into the
 * new multi-server map -- an existing cached token isn't lost just because
 * this machine hasn't talked to a second server yet. Separated from
 * `readConfig` so the migration logic is unit-testable without touching the
 * filesystem, same split as `manifest.ts`'s `parseManifest`/
 * `loadManifestFromFile`. The migration only happens in memory; it's
 * persisted back to disk the next time a caller writes (every write path
 * already does, via `setServerAuth` + `writeConfig`).
 */
export function parseConfig(raw: unknown): TwingConfig {
  if (isLegacyShape(raw)) {
    if (!raw.serverUrl) return { servers: {} };
    return { servers: { [normalizeServerUrl(raw.serverUrl)]: { authToken: raw.authToken } } };
  }
  const config = (raw ?? {}) as TwingConfig;
  return { servers: config.servers ?? {} };
}

/** Reads `~/.twing/config.json` via `parseConfig` above. */
export function readConfig(): TwingConfig {
  const p = configPath();
  if (!fs.existsSync(p)) return { servers: {} };
  try {
    return parseConfig(JSON.parse(fs.readFileSync(p, "utf8")));
  } catch {
    return { servers: {} };
  }
}

export function writeConfig(config: TwingConfig): void {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + "\n");
}

/** Cached auth for one server, or undefined if this machine has never
 * logged in to it. Normalizes `serverUrl` before lookup -- defense in
 * depth, so a caller that obtained it from somewhere other than
 * `normalizeServerUrl` (e.g. a hand-edited `twing.yml`) still hits the same
 * map key rather than silently missing. */
export function getServerAuth(config: TwingConfig, serverUrl: string): ServerAuth | undefined {
  return config.servers?.[normalizeServerUrl(serverUrl)];
}

/** Returns a new config with `serverUrl`'s entry replaced -- callers persist
 * it via `writeConfig`. Immutable rather than mutating `config` in place, to
 * match this module's existing read-then-write call style elsewhere in the
 * CLI (`readConfig()` ... `writeConfig({...})`). */
export function setServerAuth(config: TwingConfig, serverUrl: string, auth: ServerAuth): TwingConfig {
  const key = normalizeServerUrl(serverUrl);
  return { ...config, servers: { ...config.servers, [key]: auth } };
}
