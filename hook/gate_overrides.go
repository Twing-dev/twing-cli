package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// gate_overrides.go mirrors packages/core/src/gate-overrides.ts --
// ~/.twing/gate-overrides.json, a per-project map deciding whether the §17
// design gate is disabled for that project on this machine. Exists because
// hook wiring is machine-global now (wire-hooks.ts) instead of per-repo, so
// `twing design disable-gate` can no longer work by unwiring a repo-local
// hook entry -- unwiring a global entry would disable the gate everywhere,
// not just one repo. Read-only on this side -- only the TS CLI
// (`design enable-gate`/`disable-gate`) ever writes this file.
func gateOverridesPath() (string, bool) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", false
	}
	return filepath.Join(home, ".twing", "gate-overrides.json"), true
}

func isGateDisabled(projectID string) bool {
	path, ok := gateOverridesPath()
	if !ok {
		return false
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	var overrides map[string]string
	if err := json.Unmarshal(data, &overrides); err != nil {
		return false
	}
	return overrides[projectID] == "disabled"
}
