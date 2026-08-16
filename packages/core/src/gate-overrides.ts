/**
 * Per-repo override for the §17 design gate, decoupled from hook-entry
 * wiring now that wiring is machine-global (`wire-hooks.ts`) instead of
 * per-repo (§ install-once-per-machine onboarding work). `enable-gate`/
 * `disable-gate` used to work by wiring/unwiring `PreToolUse`/`SessionEnd`
 * entries in a *repo-local* `.claude/settings.json` -- that stopped making
 * sense once wiring is global (unwiring a global entry would disable the
 * gate everywhere, not just one repo). This is the local, per-project,
 * machine-local replacement: a flat map, mirroring `config.ts`'s
 * per-server auth map pattern. Read by the Go hook (`hook/gate_overrides.go`,
 * a read-only mirror -- only this side ever writes it) on every real gate
 * check.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface GateOverrides {
  [projectId: string]: "disabled";
}

function overridesPath(): string {
  return path.join(os.homedir(), ".twing", "gate-overrides.json");
}

function readOverrides(): GateOverrides {
  try {
    return JSON.parse(fs.readFileSync(overridesPath(), "utf8")) as GateOverrides;
  } catch {
    return {};
  }
}

function writeOverrides(overrides: GateOverrides): void {
  const target = overridesPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(overrides, null, 2) + "\n");
}

export function isGateDisabled(projectId: string): boolean {
  return readOverrides()[projectId] === "disabled";
}

export function setGateDisabled(projectId: string, disabled: boolean): void {
  const overrides = readOverrides();
  if (disabled) {
    overrides[projectId] = "disabled";
  } else {
    delete overrides[projectId];
  }
  writeOverrides(overrides);
}
