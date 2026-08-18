package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// Coverage for discoverChildCoordinators -- the multi-repo ExitPlanMode
// fallback's candidate discovery (fix, 2026-08-18). Mirrors the real
// TwingMail + twinmail-ui scenario this was found from: a shared parent
// directory that isn't itself a git repo, containing several independently
// onboarded child repos.

func TestDiscoverChildCoordinators_FindsOnboardedChildRepos(t *testing.T) {
	parent := t.TempDir()
	repoA := filepath.Join(parent, "TwingMail")
	repoB := filepath.Join(parent, "twinmail-ui")
	if err := os.MkdirAll(repoA, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(repoB, 0o755); err != nil {
		t.Fatal(err)
	}
	initTempGitRepoAt(t, repoA)
	initTempGitRepoAt(t, repoB)
	writeTwingYAML(t, repoA, "coordinator:\n  serverUrl: http://localhost:8787\n")
	writeTwingYAML(t, repoB, "coordinator:\n  serverUrl: http://localhost:8787\n")

	got := discoverChildCoordinators(parent)
	if len(got) != 2 {
		t.Fatalf("discoverChildCoordinators(...) returned %d candidates, want 2: %+v", len(got), got)
	}
	names := map[string]bool{}
	for _, c := range got {
		names[c.DirName] = true
		if c.ServerURL != "http://localhost:8787" {
			t.Errorf("candidate %s ServerURL = %q, want http://localhost:8787", c.DirName, c.ServerURL)
		}
	}
	if !names["TwingMail"] || !names["twinmail-ui"] {
		t.Errorf("discoverChildCoordinators(...) dir names = %v, want both TwingMail and twinmail-ui", names)
	}
}

func TestDiscoverChildCoordinators_SkipsNonRepoAndUnonboardedChildren(t *testing.T) {
	parent := t.TempDir()
	// A plain directory, not a git repo at all.
	if err := os.MkdirAll(filepath.Join(parent, "just-a-folder"), 0o755); err != nil {
		t.Fatal(err)
	}
	// A git repo with no .twing/twing.yml -- not onboarded.
	unonboarded := filepath.Join(parent, "unonboarded-repo")
	if err := os.MkdirAll(unonboarded, 0o755); err != nil {
		t.Fatal(err)
	}
	initTempGitRepoAt(t, unonboarded)
	// A dot-prefixed directory (e.g. a tooling dir) -- skipped regardless
	// of contents.
	if err := os.MkdirAll(filepath.Join(parent, ".hidden"), 0o755); err != nil {
		t.Fatal(err)
	}
	// A real file, not a directory at all.
	if err := os.WriteFile(filepath.Join(parent, "README.md"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	got := discoverChildCoordinators(parent)
	if len(got) != 0 {
		t.Errorf("discoverChildCoordinators(...) = %+v, want no candidates", got)
	}
}

func TestDiscoverChildCoordinators_OnlyOneLevelDeep(t *testing.T) {
	parent := t.TempDir()
	nested := filepath.Join(parent, "not-a-repo", "TwingMail")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	initTempGitRepoAt(t, nested)
	writeTwingYAML(t, nested, "coordinator:\n  serverUrl: http://localhost:8787\n")

	got := discoverChildCoordinators(parent)
	if len(got) != 0 {
		t.Errorf("discoverChildCoordinators(...) = %+v, want no candidates -- a repo two levels down should not be found", got)
	}
}

func TestDiscoverChildCoordinators_NoChildrenAtAll(t *testing.T) {
	parent := t.TempDir()
	got := discoverChildCoordinators(parent)
	if len(got) != 0 {
		t.Errorf("discoverChildCoordinators(...) = %+v, want empty for a directory with no children", got)
	}
}

// initTempGitRepoAt mirrors initTempGitRepo (config_test.go) but for a
// caller-supplied, already-created directory rather than a fresh t.TempDir().
func initTempGitRepoAt(t *testing.T, dir string) {
	t.Helper()
	cmd := exec.Command("git", "init", "-q", dir)
	if err := cmd.Run(); err != nil {
		t.Fatalf("git init failed: %v", err)
	}
}
