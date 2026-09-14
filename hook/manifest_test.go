package main

import (
	"os/exec"
	"testing"
)

// Coverage for discoverChildCoordinators -- the multi-repo ExitPlanMode
// fallback's candidate discovery (fix, 2026-08-18). Mirrors the real
// TwingMail + twinmail-ui scenario this was found from: a shared parent
// directory that isn't itself a git repo, containing several independently
// onboarded child repos.

// initTempGitRepoAt mirrors initTempGitRepo (config_test.go) but for a
// caller-supplied, already-created directory rather than a fresh t.TempDir().
func initTempGitRepoAt(t *testing.T, dir string) {
	t.Helper()
	cmd := exec.Command("git", "init", "-q", dir)
	if err := cmd.Run(); err != nil {
		t.Fatalf("git init failed: %v", err)
	}
}
