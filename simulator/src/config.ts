import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const SIMULATOR_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface SessionScenario {
  label: string;
  goal: string;
}

export interface Scenario {
  name: string;
  description?: string;
  /** Directory name under simulator/fixtures/ -- never twing-cli's own source. */
  fixture: string;
  maxTurns: number;
  sessions: { a: SessionScenario; b: SessionScenario };
}

/** Accepts a bare name (looked up under simulator/scenarios/<name>.json) or
 * a path to a scenario file directly. */
export function loadScenario(nameOrPath: string): Scenario {
  const candidates = [nameOrPath, path.join(SIMULATOR_ROOT, "scenarios", `${nameOrPath}.json`)];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const scenario = JSON.parse(fs.readFileSync(candidate, "utf8")) as Scenario;
      if (!scenario.sessions?.a || !scenario.sessions?.b) {
        throw new Error(`scenario ${candidate} is missing sessions.a/sessions.b`);
      }
      return scenario;
    }
  }
  throw new Error(`no scenario found for "${nameOrPath}" (looked for that path, and simulator/scenarios/${nameOrPath}.json)`);
}

export function fixtureDir(scenario: Scenario): string {
  const dir = path.join(SIMULATOR_ROOT, "fixtures", scenario.fixture);
  if (!fs.existsSync(dir)) {
    throw new Error(`fixture "${scenario.fixture}" not found at ${dir}`);
  }
  return dir;
}
