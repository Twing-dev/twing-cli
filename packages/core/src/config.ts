/**
 * Machine-wide config (§6): `~/.twing/config.json`. Server URL, plus
 * (§17.10) an optional auth token obtained once via `twing init`'s login
 * prompt and never asked for again -- not per-developer credentials, one
 * shared secret per server.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface TwingConfig {
  serverUrl?: string;
  /** sha256(password) obtained from POST /v1/auth/login (§17.10). Absent
   * either because the server has no password configured, or because
   * `init` hasn't logged in yet. */
  authToken?: string;
}

export function configPath(): string {
  return path.join(os.homedir(), ".twing", "config.json");
}

export function readConfig(): TwingConfig {
  const p = configPath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as TwingConfig;
  } catch {
    return {};
  }
}

export function writeConfig(config: TwingConfig): void {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + "\n");
}
