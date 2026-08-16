package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// Same cases as packages/core/src/config.test.ts's normalizeServerUrl tests
// -- must stay consistent with it, same discipline as
// canonicalizeRemoteURL's documented cross-language parity requirement.
func TestNormalizeServerURL_AddsSchemeWhenMissing(t *testing.T) {
	got := normalizeServerURL("15.235.199.203:8787")
	want := "http://15.235.199.203:8787"
	if got != want {
		t.Errorf("normalizeServerURL(...) = %q, want %q", got, want)
	}
}

func TestNormalizeServerURL_LeavesExplicitSchemeAlone(t *testing.T) {
	got := normalizeServerURL("https://twing.example.com")
	want := "https://twing.example.com"
	if got != want {
		t.Errorf("normalizeServerURL(...) = %q, want %q", got, want)
	}
}

func TestNormalizeServerURL_StripsTrailingSlash(t *testing.T) {
	got := normalizeServerURL("http://localhost:8787/")
	want := "http://localhost:8787"
	if got != want {
		t.Errorf("normalizeServerURL(...) = %q, want %q", got, want)
	}
}

func TestNormalizeServerURL_NoSchemeAndTrailingSlashMatchesWithScheme(t *testing.T) {
	a := normalizeServerURL("localhost:8787/")
	b := normalizeServerURL("http://localhost:8787/")
	if a != b {
		t.Errorf("normalizeServerURL(%q) = %q, normalizeServerURL(%q) = %q, want equal", "localhost:8787/", a, "http://localhost:8787/", b)
	}
}

// initTempGitRepo creates a throwaway git repo so gitOutput(cwd, "rev-parse",
// "--show-toplevel") -- what readCoordinatorServerURL relies on for repo-root
// resolution -- has something real to find, mirroring how manifest.test.ts
// (TS side) uses a temp directory for the equivalent tests.
func initTempGitRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	cmd := exec.Command("git", "init", "-q", dir)
	if err := cmd.Run(); err != nil {
		t.Fatalf("git init failed: %v", err)
	}
	return dir
}

func writeTwingYAML(t *testing.T, repoRoot, contents string) {
	t.Helper()
	dir := filepath.Join(repoRoot, ".twing")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir .twing: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "twing.yml"), []byte(contents), 0o644); err != nil {
		t.Fatalf("write twing.yml: %v", err)
	}
}

func TestReadCoordinatorServerURL_ReadsFromCommittedFile(t *testing.T) {
	repoRoot := initTempGitRepo(t)
	writeTwingYAML(t, repoRoot, "coordinator:\n  serverUrl: http://localhost:8787\n")

	got, gotRoot, ok := readCoordinatorServerURL(repoRoot)
	if !ok || got != "http://localhost:8787" {
		t.Errorf("readCoordinatorServerURL(...) = (%q, %v), want (\"http://localhost:8787\", true)", got, ok)
	}
	// git rev-parse --show-toplevel resolves symlinks (e.g. macOS's
	// /tmp -> /private/tmp), so compare against t.TempDir()'s own
	// resolved form rather than its raw, possibly-symlinked spelling.
	wantRoot := repoRoot
	if r, err := filepath.EvalSymlinks(repoRoot); err == nil {
		wantRoot = r
	}
	if gotRoot != wantRoot {
		t.Errorf("readCoordinatorServerURL(...) repoRoot = %q, want %q", gotRoot, wantRoot)
	}
}

func TestReadCoordinatorServerURL_WorksFromASubdirectory(t *testing.T) {
	repoRoot := initTempGitRepo(t)
	writeTwingYAML(t, repoRoot, "coordinator:\n  serverUrl: http://localhost:8787\n")
	sub := filepath.Join(repoRoot, "packages", "cli")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatalf("mkdir subdir: %v", err)
	}

	got, gotRoot, ok := readCoordinatorServerURL(sub)
	if !ok || got != "http://localhost:8787" {
		t.Errorf("readCoordinatorServerURL(sub) = (%q, %v), want (\"http://localhost:8787\", true)", got, ok)
	}
	wantRoot := repoRoot
	if r, err := filepath.EvalSymlinks(repoRoot); err == nil {
		wantRoot = r
	}
	if gotRoot != wantRoot {
		t.Errorf("readCoordinatorServerURL(sub) repoRoot = %q, want %q", gotRoot, wantRoot)
	}
}

func TestReadCoordinatorServerURL_IgnoresOtherManifestSections(t *testing.T) {
	repoRoot := initTempGitRepo(t)
	writeTwingYAML(t, repoRoot, "require_human_review:\n  - path: \"hook/**\"\n    reason: x\nconstraints:\n  - text: y\n    scope: z\n")

	_, _, ok := readCoordinatorServerURL(repoRoot)
	if ok {
		t.Errorf("readCoordinatorServerURL(...) = ok, want false for a manifest with no coordinator section")
	}
}

func TestReadCoordinatorServerURL_NoTwingYamlAtAll(t *testing.T) {
	repoRoot := initTempGitRepo(t)
	_, _, ok := readCoordinatorServerURL(repoRoot)
	if ok {
		t.Errorf("readCoordinatorServerURL(...) = ok, want false when .twing/twing.yml doesn't exist")
	}
}

// withFakeHome points os.UserHomeDir() (via $HOME, which it consults on
// darwin/linux) at a throwaway directory for the duration of one test --
// t.Setenv restores the real value automatically afterward.
func withFakeHome(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	return dir
}

func writeGlobalConfig(t *testing.T, home, contents string) {
	t.Helper()
	dir := filepath.Join(home, ".twing")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir ~/.twing: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(contents), 0o644); err != nil {
		t.Fatalf("write config.json: %v", err)
	}
}

func TestReadGlobalConfig_MigratesLegacyShape(t *testing.T) {
	withFakeHome(t)
	writeGlobalConfig(t, os.Getenv("HOME"), `{"serverUrl":"http://localhost:8787","authToken":"tok-a"}`)

	cfg := readGlobalConfig()
	auth, ok := cfg.Servers["http://localhost:8787"]
	if !ok || auth.AuthToken != "tok-a" {
		t.Errorf("readGlobalConfig() servers = %v, want a \"http://localhost:8787\" entry with authToken \"tok-a\"", cfg.Servers)
	}
}

func TestReadGlobalConfig_ReadsNewMultiServerShape(t *testing.T) {
	withFakeHome(t)
	writeGlobalConfig(t, os.Getenv("HOME"), `{"servers":{"http://a":{"authToken":"tok-a"},"http://b":{}}}`)

	cfg := readGlobalConfig()
	if cfg.Servers["http://a"].AuthToken != "tok-a" {
		t.Errorf("readGlobalConfig() servers[http://a].AuthToken = %q, want \"tok-a\"", cfg.Servers["http://a"].AuthToken)
	}
	if cfg.Servers["http://b"].AuthToken != "" {
		t.Errorf("readGlobalConfig() servers[http://b].AuthToken = %q, want empty", cfg.Servers["http://b"].AuthToken)
	}
}

func TestReadGlobalConfig_MissingFileIsEmptyNotAnError(t *testing.T) {
	withFakeHome(t)
	cfg := readGlobalConfig()
	if len(cfg.Servers) != 0 {
		t.Errorf("readGlobalConfig() servers = %v, want empty for a missing config file", cfg.Servers)
	}
}

func TestResolveServerConfig_CombinesRepoCoordinatorWithCachedToken(t *testing.T) {
	withFakeHome(t)
	writeGlobalConfig(t, os.Getenv("HOME"), `{"servers":{"http://localhost:8787":{"authToken":"tok-a"}}}`)
	repoRoot := initTempGitRepo(t)
	writeTwingYAML(t, repoRoot, "coordinator:\n  serverUrl: http://localhost:8787\n")

	cfg := resolveServerConfig(repoRoot)
	if cfg.ServerURL != "http://localhost:8787" || cfg.AuthToken != "tok-a" {
		t.Errorf("resolveServerConfig(...) = %+v, want {ServerURL: http://localhost:8787, AuthToken: tok-a}", cfg)
	}
}

func TestResolveServerConfig_KnownServerButNoCachedToken(t *testing.T) {
	withFakeHome(t) // empty ~/.twing/config.json -- never logged in on this machine
	repoRoot := initTempGitRepo(t)
	writeTwingYAML(t, repoRoot, "coordinator:\n  serverUrl: http://localhost:8787\n")

	cfg := resolveServerConfig(repoRoot)
	if cfg.ServerURL != "http://localhost:8787" || cfg.AuthToken != "" {
		t.Errorf("resolveServerConfig(...) = %+v, want ServerURL set and AuthToken empty (server has no password, or this machine hasn't logged in)", cfg)
	}
}

func TestResolveServerConfig_NoCoordinatorConfigured(t *testing.T) {
	withFakeHome(t)
	repoRoot := initTempGitRepo(t)

	cfg := resolveServerConfig(repoRoot)
	if cfg.ServerURL != "" {
		t.Errorf("resolveServerConfig(...) = %+v, want empty ServerURL for a repo with no .twing/twing.yml", cfg)
	}
}
