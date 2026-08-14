package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Fail-closed coverage for design_gate.go (2026-08-13 reversal of the
// original §17.7 fail-open recommendation -- see the header comment in
// design_gate.go for why). Every test here asserts a *deny* with a specific,
// distinguishable reason for each of the three failure classes -- no cached
// token, a rejected token, and an unreachable/malformed coordinator -- plus
// the one path that's still a silent allow: no coordinator configured at
// all, which isn't a failure.

// newTestRepo makes a throwaway git repo (no remote needed --
// computeProjectID falls back to a persisted random id) with a
// .twing/twing.yml pointing at serverURL. Pass "" to omit the coordinator
// block entirely (the "gate not configured here" case).
func newTestRepo(t *testing.T, serverURL string) string {
	t.Helper()
	dir := t.TempDir()
	run := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("init", "-q")

	if serverURL == "" {
		return dir
	}
	twingDir := filepath.Join(dir, ".twing")
	if err := os.MkdirAll(twingDir, 0o755); err != nil {
		t.Fatal(err)
	}
	yml := fmt.Sprintf("coordinator:\n  serverUrl: %s\n", serverURL)
	if err := os.WriteFile(filepath.Join(twingDir, "twing.yml"), []byte(yml), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

// setCachedToken points $HOME at an isolated dir for the duration of the
// test (never touches the real machine's ~/.twing/config.json) and, if
// token is non-empty, caches it for serverURL the same shape
// readGlobalConfig expects.
func setCachedToken(t *testing.T, serverURL, token string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	if token == "" {
		return
	}
	cfgDir := filepath.Join(home, ".twing")
	if err := os.MkdirAll(cfgDir, 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := fmt.Sprintf(`{"servers":{%q:{"authToken":%q}}}`, serverURL, token)
	if err := os.WriteFile(filepath.Join(cfgDir, "config.json"), []byte(cfg), 0o644); err != nil {
		t.Fatal(err)
	}
}

// captureStdout redirects os.Stdout for the duration of fn and returns
// whatever it wrote -- design_gate.go's handlers write directly to
// os.Stdout (writeJSON), same as they do for real, so this exercises the
// real code path rather than a mock of it.
func captureStdout(t *testing.T, fn func()) string {
	t.Helper()
	old := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = w
	fn()
	w.Close()
	os.Stdout = old

	buf := make([]byte, 64*1024)
	n, _ := r.Read(buf)
	return string(buf[:n])
}

func decisionOf(t *testing.T, stdout string) (decision, reason string) {
	t.Helper()
	if stdout == "" {
		return "", ""
	}
	var parsed struct {
		HookSpecificOutput struct {
			PermissionDecision       string `json:"permissionDecision"`
			PermissionDecisionReason string `json:"permissionDecisionReason"`
		} `json:"hookSpecificOutput"`
	}
	if err := json.Unmarshal([]byte(stdout), &parsed); err != nil {
		t.Fatalf("stdout did not parse as hook JSON: %v\nstdout: %s", err, stdout)
	}
	return parsed.HookSpecificOutput.PermissionDecision, parsed.HookSpecificOutput.PermissionDecisionReason
}

func editPayload(cwd, sessionID string) hookPayload {
	return hookPayload{
		SessionID: sessionID,
		Cwd:       cwd,
		ToolName:  "Edit",
		ToolInput: json.RawMessage(`{"file_path":"foo.go"}`),
	}
}

func planPayload(cwd, sessionID string) hookPayload {
	return hookPayload{
		SessionID: sessionID,
		Cwd:       cwd,
		ToolName:  "ExitPlanMode",
		ToolInput: json.RawMessage(`{"plan":"do the thing"}`),
	}
}

// --- Edit|Write gate ---

func TestHandleEditWriteGate_NoCachedToken_DeniesWithoutNetworkCall(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatalf("unexpected network call to %s -- a missing token must deny before any request", r.URL.Path)
	}))
	defer server.Close()

	repo := newTestRepo(t, server.URL)
	setCachedToken(t, server.URL, "")

	stdout := captureStdout(t, func() { handleEditWriteGate(editPayload(repo, "sess1")) })
	decision, reason := decisionOf(t, stdout)
	if decision != "deny" {
		t.Fatalf("decision = %q, want deny", decision)
	}
	if !strings.Contains(reason, "no auth token cached") {
		t.Errorf("reason = %q, want it to mention no cached token", reason)
	}
}

func TestHandleEditWriteGate_ConstraintCheckAuthRejected_Denies(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()

	repo := newTestRepo(t, server.URL)
	setCachedToken(t, server.URL, "stale-token")

	stdout := captureStdout(t, func() { handleEditWriteGate(editPayload(repo, "sess1")) })
	decision, reason := decisionOf(t, stdout)
	if decision != "deny" {
		t.Fatalf("decision = %q, want deny", decision)
	}
	if !strings.Contains(reason, "authentication rejected") {
		t.Errorf("reason = %q, want it to mention rejected authentication", reason)
	}
}

func TestHandleEditWriteGate_CoordinatorUnreachable_Denies(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	deadURL := server.URL
	server.Close() // closed before use -> connection refused, deterministically unreachable

	repo := newTestRepo(t, deadURL)
	setCachedToken(t, deadURL, "some-token")

	stdout := captureStdout(t, func() { handleEditWriteGate(editPayload(repo, "sess1")) })
	decision, reason := decisionOf(t, stdout)
	if decision != "deny" {
		t.Fatalf("decision = %q, want deny", decision)
	}
	if !strings.Contains(reason, "unreachable") {
		t.Errorf("reason = %q, want it to mention unreachable", reason)
	}
}

func TestHandleEditWriteGate_ConstraintMatched_DeniesAndSkipsOpenDesignsCall(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/constraints/match":
			w.Header().Set("content-type", "application/json")
			_, _ = w.Write([]byte(`{"matched":true,"constraint":{"statement":"needs review","type":"review_required"}}`))
		case "/v1/designs/scope-match":
			t.Fatal("scope-match lookup should not run once the constraint check matched")
		}
	}))
	defer server.Close()

	repo := newTestRepo(t, server.URL)
	setCachedToken(t, server.URL, "some-token")

	stdout := captureStdout(t, func() { handleEditWriteGate(editPayload(repo, "sess1")) })
	decision, reason := decisionOf(t, stdout)
	if decision != "deny" {
		t.Fatalf("decision = %q, want deny", decision)
	}
	if !strings.Contains(reason, "needs review") {
		t.Errorf("reason = %q, want it to include the constraint statement", reason)
	}
}

func TestHandleEditWriteGate_OpenDesignsUnexpectedStatus_Denies(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/constraints/match":
			w.Header().Set("content-type", "application/json")
			_, _ = w.Write([]byte(`{"matched":false}`))
		case "/v1/designs/scope-match":
			w.WriteHeader(http.StatusInternalServerError)
		}
	}))
	defer server.Close()

	repo := newTestRepo(t, server.URL)
	setCachedToken(t, server.URL, "some-token")

	stdout := captureStdout(t, func() { handleEditWriteGate(editPayload(repo, "sess1")) })
	decision, reason := decisionOf(t, stdout)
	if decision != "deny" {
		t.Fatalf("decision = %q, want deny", decision)
	}
	if !strings.Contains(reason, "coordinator error") {
		t.Errorf("reason = %q, want it to mention a coordinator error", reason)
	}
}

func TestHandleEditWriteGate_NoOpenDesign_DeniesWithRegisterInstructions(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/constraints/match":
			_, _ = w.Write([]byte(`{"matched":false}`))
		case "/v1/designs/scope-match":
			_, _ = w.Write([]byte(`{"state":"no_design"}`))
		}
	}))
	defer server.Close()

	repo := newTestRepo(t, server.URL)
	setCachedToken(t, server.URL, "some-token")

	stdout := captureStdout(t, func() { handleEditWriteGate(editPayload(repo, "sess1")) })
	decision, reason := decisionOf(t, stdout)
	if decision != "deny" {
		t.Fatalf("decision = %q, want deny", decision)
	}
	if !strings.Contains(reason, "no design registered") {
		t.Errorf("reason = %q, want it to mention no design registered", reason)
	}
}

func TestHandleEditWriteGate_InScope_Allows(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/constraints/match":
			_, _ = w.Write([]byte(`{"matched":false}`))
		case "/v1/designs/scope-match":
			if r.URL.Query().Get("path") != "foo.go" {
				t.Errorf("scope-match path = %q, want foo.go", r.URL.Query().Get("path"))
			}
			_, _ = w.Write([]byte(`{"state":"in_scope","designId":"d1"}`))
		}
	}))
	defer server.Close()

	repo := newTestRepo(t, server.URL)
	setCachedToken(t, server.URL, "some-token")

	stdout := captureStdout(t, func() { handleEditWriteGate(editPayload(repo, "sess1")) })
	decision, _ := decisionOf(t, stdout)
	if decision != "allow" {
		t.Fatalf("decision = %q, want allow", decision)
	}
}

// A tool call with no file_path at all (ToolInput doesn't decode a path) --
// the constraint check is skipped entirely (unchanged, existing behavior),
// and the scope-match call is still made but with no `path`, which the
// server treats permissively ("can't verify scope without a path", same
// permissiveness the old plain "has an open design" check had). Only
// no_design/flagged states are actually distinguishable without a path.
func TestHandleEditWriteGate_NoFilePath_ScopeMatchOmitsPathAndStillAllows(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/constraints/match":
			t.Errorf("constraint match must not be called when there's no file_path")
		case "/v1/designs/scope-match":
			if got := r.URL.Query().Get("path"); got != "" {
				t.Errorf("scope-match path = %q, want omitted", got)
			}
			_, _ = w.Write([]byte(`{"state":"in_scope","designId":"d1"}`))
		}
	}))
	defer server.Close()

	repo := newTestRepo(t, server.URL)
	setCachedToken(t, server.URL, "some-token")

	payload := hookPayload{SessionID: "sess1", Cwd: repo, ToolName: "Write", ToolInput: json.RawMessage(`{}`)}
	stdout := captureStdout(t, func() { handleEditWriteGate(payload) })
	decision, _ := decisionOf(t, stdout)
	if decision != "allow" {
		t.Fatalf("decision = %q, want allow", decision)
	}
}

func TestHandleEditWriteGate_Flagged_DeniesWithResolveInstructions(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/constraints/match":
			_, _ = w.Write([]byte(`{"matched":false}`))
		case "/v1/designs/scope-match":
			_, _ = w.Write([]byte(`{"state":"flagged","designId":"d-flagged"}`))
		}
	}))
	defer server.Close()

	repo := newTestRepo(t, server.URL)
	setCachedToken(t, server.URL, "some-token")

	stdout := captureStdout(t, func() { handleEditWriteGate(editPayload(repo, "sess1")) })
	decision, reason := decisionOf(t, stdout)
	if decision != "deny" {
		t.Fatalf("decision = %q, want deny", decision)
	}
	if !strings.Contains(reason, "d-flagged") || !strings.Contains(reason, "design resolve") {
		t.Errorf("reason = %q, want it to name the flagged design and point at `twing design resolve`", reason)
	}
}

func TestHandleEditWriteGate_OutOfScope_DeniesWithAmendInstructions(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/constraints/match":
			_, _ = w.Write([]byte(`{"matched":false}`))
		case "/v1/designs/scope-match":
			_, _ = w.Write([]byte(`{"state":"out_of_scope","designId":"d1"}`))
		}
	}))
	defer server.Close()

	repo := newTestRepo(t, server.URL)
	setCachedToken(t, server.URL, "some-token")

	stdout := captureStdout(t, func() { handleEditWriteGate(editPayload(repo, "sess1")) })
	decision, reason := decisionOf(t, stdout)
	if decision != "deny" {
		t.Fatalf("decision = %q, want deny", decision)
	}
	if !strings.Contains(reason, "foo.go") || !strings.Contains(reason, "d1") || !strings.Contains(reason, "design amend") {
		t.Errorf("reason = %q, want it to name the file, the design id, and point at `twing design amend`", reason)
	}
}

func TestHandleEditWriteGate_NoCoordinatorConfigured_SilentNoOp(t *testing.T) {
	repo := newTestRepo(t, "") // no .twing/twing.yml at all
	setCachedToken(t, "http://unused.invalid", "")

	stdout := captureStdout(t, func() { handleEditWriteGate(editPayload(repo, "sess1")) })
	if stdout != "" {
		t.Errorf("stdout = %q, want empty (gate not configured for this repo is not a failure)", stdout)
	}
}

// --- ExitPlanMode gate ---

func TestHandleExitPlanMode_NoCachedToken_DeniesWithoutNetworkCall(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatalf("unexpected network call to %s -- a missing token must deny before any request", r.URL.Path)
	}))
	defer server.Close()

	repo := newTestRepo(t, server.URL)
	setCachedToken(t, server.URL, "")

	stdout := captureStdout(t, func() { handleExitPlanMode(planPayload(repo, "sess1")) })
	decision, reason := decisionOf(t, stdout)
	if decision != "deny" {
		t.Fatalf("decision = %q, want deny", decision)
	}
	if !strings.Contains(reason, "no auth token cached") {
		t.Errorf("reason = %q, want it to mention no cached token", reason)
	}
}

func TestHandleExitPlanMode_CoordinatorUnreachable_Denies(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	deadURL := server.URL
	server.Close()

	repo := newTestRepo(t, deadURL)
	setCachedToken(t, deadURL, "some-token")

	stdout := captureStdout(t, func() { handleExitPlanMode(planPayload(repo, "sess1")) })
	decision, reason := decisionOf(t, stdout)
	if decision != "deny" {
		t.Fatalf("decision = %q, want deny", decision)
	}
	if !strings.Contains(reason, "unreachable") {
		t.Errorf("reason = %q, want it to mention unreachable", reason)
	}
}

func TestHandleExitPlanMode_CleanVerdict_Allows(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"verdict":"clean","designId":"d1"}`))
	}))
	defer server.Close()

	repo := newTestRepo(t, server.URL)
	setCachedToken(t, server.URL, "some-token")

	stdout := captureStdout(t, func() { handleExitPlanMode(planPayload(repo, "sess1")) })
	decision, _ := decisionOf(t, stdout)
	if decision != "allow" {
		t.Fatalf("decision = %q, want allow", decision)
	}
}

// --- kill switch, unaffected by the fail-closed change ---

func TestHandlePreToolUse_DesignGateOff_NoOp(t *testing.T) {
	t.Setenv("TWING_DESIGN_GATE", "off")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("TWING_DESIGN_GATE=off must not make any network call")
	}))
	defer server.Close()

	repo := newTestRepo(t, server.URL)
	setCachedToken(t, server.URL, "some-token")

	stdout := captureStdout(t, func() { handlePreToolUse(editPayload(repo, "sess1")) })
	if stdout != "" {
		t.Errorf("stdout = %q, want empty", stdout)
	}
}
