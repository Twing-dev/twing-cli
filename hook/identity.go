package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
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

// generateGroupID mints a fresh, unpersisted random id (§17 design linking,
// 2026-08) -- same crypto/rand + hex.EncodeToString mechanic as
// readOrCreatePersistedID above, deliberately without the disk-persistence
// half: a plan's groupId only needs to stay stable for the duration of one
// ExitPlanMode invocation (reused across every matching candidate's
// registration call within that single pass), never across separate
// invocations -- see design-store.ts's reregisterFromPlan doc comment for
// why a *retried* plan safely discards a freshly-minted groupId here rather
// than needing one persisted.
func generateGroupID() string {
	buf := make([]byte, 16)
	_, _ = rand.Read(buf)
	return hex.EncodeToString(buf)
}

var scpLikeRemoteRe = regexp.MustCompile(`^[^@/]+@([^:/]+):(.+)$`)
var schemeRemoteRe = regexp.MustCompile(`(?i)^[a-z][a-z0-9+.-]*://(?:[^@/]+@)?`)

// canonicalizeRemoteURL mirrors core/identity.ts's canonicalizeRemoteUrl --
// must stay byte-for-byte equivalent, or cross-session detection breaks the
// same way it did in production, 2026-08-11 (SSH vs HTTPS clones of the
// same repo hashing to different projectIds).
func canonicalizeRemoteURL(raw string) string {
	s := strings.TrimSpace(raw)

	if m := scpLikeRemoteRe.FindStringSubmatch(s); m != nil {
		s = m[1] + "/" + m[2]
	} else {
		s = schemeRemoteRe.ReplaceAllString(s, "")
	}

	if strings.HasSuffix(strings.ToLower(s), ".git") {
		s = s[:len(s)-len(".git")]
	}
	s = strings.TrimRight(s, "/")

	return strings.ToLower(s)
}

// computeProjectID mirrors identity.ts's computeProjectId: sha256(canonicalized
// git remote get-url origin), falling back to a gitignored random id per repo
// (§8). `cwd` need not be the repo root -- git resolves the enclosing repo
// from any subdirectory.
func computeProjectID(cwd string) string {
	if remoteURL, ok := gitOutput(cwd, "remote", "get-url", "origin"); ok && remoteURL != "" {
		sum := sha256.Sum256([]byte(canonicalizeRemoteURL(remoteURL)))
		return hex.EncodeToString(sum[:])
	}
	return readOrCreatePersistedID(filepath.Join(cwd, ".git", "twing-project-id"))
}

// developerId is no longer computed on this side at all for the full-auth
// path (§17.10 hardening): the server resolves it from the authenticated
// bearer PAT, never from anything the hook could compute locally. The
// original `computeDeveloperID` was removed along with its one call site
// in design_gate.go for exactly that reason.
//
// computeDeveloperID below is its reintroduction, scoped to §17 Phase 4
// only: a --no-auth coordinator has no bearer token to resolve an identity
// from at all, so *something* self-declared has to travel as
// X-Twing-Developer-Id -- mirrors identity.ts's computeDeveloperId
// (git-email-derived, falling back to a persisted random id) exactly.
// Every call site must gate this behind config.NoAuth; it must never be
// called on the full-auth path.
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
