/**
 * Machine-wide config (§6): `~/.twing/config.json`. Just the server URL —
 * no token, no credentials, v0 has no authentication at all (§7).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface TwingConfig {
  serverUrl?: string;
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
