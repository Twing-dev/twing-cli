package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func writeGateOverrides(t *testing.T, home string, overrides map[string]string) {
	t.Helper()
	dir := filepath.Join(home, ".twing")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	data := "{"
	first := true
	for k, v := range overrides {
		if !first {
			data += ","
		}
		first = false
		data += `"` + k + `":"` + v + `"`
	}
	data += "}"
	if err := os.WriteFile(filepath.Join(dir, "gate-overrides.json"), []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestIsGateDisabled_NoFile(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if isGateDisabled("proj-1") {
		t.Error("isGateDisabled() = true, want false when the overrides file doesn't exist")
	}
}

func TestIsGateDisabled_ProjectListedDisabled(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	writeGateOverrides(t, home, map[string]string{"proj-1": "disabled"})
	if !isGateDisabled("proj-1") {
		t.Error("isGateDisabled(proj-1) = false, want true")
	}
	if isGateDisabled("proj-2") {
		t.Error("isGateDisabled(proj-2) = true, want false -- override is per-project, not global")
	}
}

func TestIsGateDisabled_MalformedFile(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".twing")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "gate-overrides.json"), []byte("not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	if isGateDisabled("proj-1") {
		t.Error("isGateDisabled() = true, want false for a malformed overrides file")
	}
}

// End-to-end through the real gate handler: a disabled project must allow
// silently and never reach the network, same as "no coordinator
// configured" -- the override is checked before any HTTP call.
func TestHandleEditWriteGate_ProjectOverrideDisabled_AllowsSilentlyNoNetworkCall(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatalf("unexpected network call to %s -- a disabled project must never reach the coordinator", r.URL.Path)
	}))
	defer server.Close()

	repo := newTestRepo(t, server.URL)
	setCachedToken(t, server.URL, "some-token")

	// setCachedToken already isolates $HOME to a fresh t.TempDir() -- read
	// it back so the override file lands in the same place the hook reads.
	home := os.Getenv("HOME")
	writeGateOverrides(t, home, map[string]string{computeProjectID(repo): "disabled"})

	stdout := captureStdout(t, func() { handleEditWriteGate(editPayload(repo, "sess1")) })
	if stdout != "" {
		t.Errorf("stdout = %q, want empty (a disabled project must allow silently)", stdout)
	}
}
