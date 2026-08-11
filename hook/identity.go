package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Go port of packages/core/src/identity.ts's computeProjectId/
// computeDeveloperId, for the §17 design-gate path only -- this hook binary
// deliberately has no shared code with the TS side (design doc §4), so the
// logic is duplicated here rather than imported.

func gitOutput(cwd string, args ...string) (string, bool) {
	cmd := exec.Command("git", args...)
	cmd.Dir = cwd
	out, err := cmd.Output()
	if err != nil {
		return "", false
	}
	return strings.TrimSpace(string(out)), true
}

func readOrCreatePersistedID(idPath string) string {
	if data, err := os.ReadFile(idPath); err == nil {
		if trimmed := strings.TrimSpace(string(data)); trimmed != "" {
			return trimmed
		}
	}
	buf := make([]byte, 16)
	_, _ = rand.Read(buf)
	generated := hex.EncodeToString(buf)
	_ = os.MkdirAll(filepath.Dir(idPath), 0o755)
	_ = os.WriteFile(idPath, []byte(generated), 0o644)
	return generated
}

// computeProjectID mirrors identity.ts's computeProjectId: sha256(git remote
// get-url origin), falling back to a gitignored random id per repo (§8).
// `cwd` need not be the repo root -- git resolves the enclosing repo from
// any subdirectory.
func computeProjectID(cwd string) string {
	if remoteURL, ok := gitOutput(cwd, "remote", "get-url", "origin"); ok && remoteURL != "" {
		sum := sha256.Sum256([]byte(remoteURL))
		return hex.EncodeToString(sum[:])
	}
	return readOrCreatePersistedID(filepath.Join(cwd, ".git", "twing-project-id"))
}

// computeDeveloperID mirrors identity.ts's computeDeveloperId.
func computeDeveloperID(cwd string) string {
	if email, ok := gitOutput(cwd, "config", "user.email"); ok && email != "" {
		return email
	}
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	return readOrCreatePersistedID(filepath.Join(home, ".twing", "id"))
}
