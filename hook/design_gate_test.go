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

// setCachedNoAuth is setCachedToken's §17 Phase 4 counterpart: caches
// noAuth:true for serverURL instead of a token, same isolated-$HOME
// mechanics. Never sets authToken -- a no_auth coordinator never issues
// one, and the whole point of these tests is proving the gate proceeds
// without one when (and only when) this flag is set.
func setCachedNoAuth(t *testing.T, serverURL string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	cfgDir := filepath.Join(home, ".twing")
	if err := os.MkdirAll(cfgDir, 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := fmt.Sprintf(`{"servers":{%q:{"noAuth":true}}}`, serverURL)
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

// §17 Phase 4: the one place a missing-token state now means two different
// things -- this is the security-relevant regression to guard specifically.
// With noAuth cached true, no cached authToken must NOT deny; the request
// must go out carrying a self-declared X-Twing-Developer-Id header instead
// of an Authorization bearer.
func TestHandleEditWriteGate_NoAuthCached_NoTokenStillProceeds_SendsDeveloperIdHeader(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("authorization") != "" {
			t.Errorf("unexpected authorization header on a no_auth request: %q", r.Header.Get("authorization"))
		}
		if r.Header.Get("x-twing-developer-id") == "" {
			t.Errorf("missing x-twing-developer-id header on a no_auth request")
		}
		switch r.URL.Path {
		case "/v1/constraints/match":
			_, _ = w.Write([]byte(`{"matched":false}`))
		case "/v1/designs/scope-match":
			_, _ = w.Write([]byte(`{"state":"in_scope","designId":"d1"}`))
		}
	}))
	defer server.Close()

	repo := newTestRepo(t, server.URL)
	setCachedNoAuth(t, server.URL)

	stdout := captureStdout(t, func() { handleEditWriteGate(editPayload(repo, "sess1")) })
	decision, reason := decisionOf(t, stdout)
	if decision != "allow" {
		t.Fatalf("decision = %q, reason = %q, want allow (a no_auth coordinator must proceed without a cached token)", decision, reason)
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
			_, _ = w.Write([]byte(`{"matched":true,"constraints":[{"statement":"needs review","type":"review_required"}]}`))
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

// §17 design lifecycle (2026-08): a dormant design is never silently
// allowed or woken -- the reason must name the design, show its summary,
// and point at `twing design resume` rather than just retrying the edit.
func TestHandleEditWriteGate_Dormant_DeniesWithResumeInstructions(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/constraints/match":
			_, _ = w.Write([]byte(`{"matched":false}`))
		case "/v1/designs/scope-match":
			_, _ = w.Write([]byte(`{"state":"dormant","designId":"d-dormant","summary":"the paused refactor","dormantSinceMs":10800000}`))
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
	if !strings.Contains(reason, "d-dormant") || !strings.Contains(reason, "the paused refactor") || !strings.Contains(reason, "design resume") {
		t.Errorf("reason = %q, want it to name the dormant design, its summary, and point at `twing design resume`", reason)
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

// Found live: drafting a plan file (~/.claude/plans/*.md, entirely outside
// any gated repo) while a twing-gated session was active got denied for "no
// design registered" -- the gate resolved the coordinator from the
// session's cwd and never checked whether the actual write target was even
// inside that repo. A repo's coordinator has no jurisdiction over a file
// that isn't part of it; this must resolve to the same silent allow as "no
// coordinator configured," and must never reach the network.
func TestHandleEditWriteGate_FilePathOutsideRepo_AllowsSilently(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatalf("unexpected network call to %s -- a file outside the repo must never reach the coordinator", r.URL.Path)
	}))
	defer server.Close()

	repo := newTestRepo(t, server.URL)
	setCachedToken(t, server.URL, "some-token")

	outside := t.TempDir() // a different tree entirely, no relation to repo
	payload := hookPayload{
		SessionID: "sess1",
		Cwd:       repo,
		ToolName:  "Write",
		ToolInput: json.RawMessage(fmt.Sprintf(`{"file_path":%q}`, filepath.Join(outside, "plan.md"))),
	}

	stdout := captureStdout(t, func() { handleEditWriteGate(payload) })
	if stdout != "" {
		t.Errorf("stdout = %q, want empty (a path outside the repo is not this coordinator's concern)", stdout)
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

// §17 Phase 4: same regression coverage as the Edit|Write gate above, for
// the ExitPlanMode path.
func TestHandleExitPlanMode_NoAuthCached_NoTokenStillProceeds_SendsDeveloperIdHeader(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("authorization") != "" {
			t.Errorf("unexpected authorization header on a no_auth request: %q", r.Header.Get("authorization"))
		}
		if r.Header.Get("x-twing-developer-id") == "" {
			t.Errorf("missing x-twing-developer-id header on a no_auth request")
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"verdict":"clean","designId":"d1"}`))
	}))
	defer server.Close()

	repo := newTestRepo(t, server.URL)
	setCachedNoAuth(t, server.URL)

	stdout := captureStdout(t, func() { handleExitPlanMode(planPayload(repo, "sess1")) })
	decision, reason := decisionOf(t, stdout)
	if decision != "allow" {
		t.Fatalf("decision = %q, reason = %q, want allow (a no_auth coordinator must proceed without a cached token)", decision, reason)
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

// 2026-08-19 severity split (design-checks.ts): a "warning"-severity
// "overlap" verdict (tier 1's exactOverlap only, currently) registers and
// allows same as clean -- the conflict is still recorded server-side for
// display, just not gate-relevant.
func TestHandleExitPlanMode_OverlapWarningSeverity_Allows(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"verdict":"overlap","severity":"warning","designId":"d1","conflicts":[{"conflictingDesignId":"d-other","overlapKind":"touches","overlapDetail":"both touch shared.ts","conflictingSummary":"another session's work"}]}`))
	}))
	defer server.Close()

	repo := newTestRepo(t, server.URL)
	setCachedToken(t, server.URL, "some-token")

	stdout := captureStdout(t, func() { handleExitPlanMode(planPayload(repo, "sess1")) })
	decision, reason := decisionOf(t, stdout)
	if decision != "allow" {
		t.Fatalf("decision = %q, reason = %q, want allow", decision, reason)
	}
}

// Companion to the warning-severity test above -- an "overlap" verdict with
// no severity field at all (today's original response shape, still valid
// for tier 4/constraint_flag, and any coordinator not yet upgraded) must
// still deny, same as before this split.
func TestHandleExitPlanMode_OverlapNoSeverity_StillDenies(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"verdict":"overlap","designId":"d1","conflicts":[{"conflictingDesignId":"d-other","overlapKind":"touches","overlapDetail":"summaries are 80% similar","conflictingSummary":"another session's work"}]}`))
	}))
	defer server.Close()

	repo := newTestRepo(t, server.URL)
	setCachedToken(t, server.URL, "some-token")

	stdout := captureStdout(t, func() { handleExitPlanMode(planPayload(repo, "sess1")) })
	decision, _ := decisionOf(t, stdout)
	if decision != "deny" {
		t.Fatalf("decision = %q, want deny", decision)
	}
}

// --- multi-repo cwd fix (2026-08-18): Edit/Write resolves from the file
// path, not cwd; ExitPlanMode falls back to multi-candidate discovery ---

// Reproduces the real gap this fix closes: cwd is a shared parent of
// several independently onboarded repos (the TwingMail/twinmail-ui
// workflow), not a repo itself -- previously a silent no-op for every
// Edit/Write in that setup. Resolving from the file's own path instead
// must make the gate fire exactly as it would from inside the repo.
func TestHandleEditWriteGate_CwdIsParentOfRepo_ResolvesFromFilePath(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/constraints/match":
			_, _ = w.Write([]byte(`{"matched":false}`))
		case "/v1/designs/scope-match":
			if r.URL.Query().Get("path") != "packages/api/mailbox.ts" {
				t.Errorf("scope-match path = %q, want packages/api/mailbox.ts", r.URL.Query().Get("path"))
			}
			_, _ = w.Write([]byte(`{"state":"in_scope","designId":"d1"}`))
		}
	}))
	defer server.Close()

	parent := t.TempDir() // not itself a git repo
	repo := newTestRepo(t, server.URL)
	movedRepo := filepath.Join(parent, "TwingMail")
	if err := os.Rename(repo, movedRepo); err != nil {
		t.Fatal(err)
	}
	fileDir := filepath.Join(movedRepo, "packages", "api")
	if err := os.MkdirAll(fileDir, 0o755); err != nil {
		t.Fatal(err)
	}
	setCachedToken(t, server.URL, "some-token")

	payload := hookPayload{
		SessionID: "sess1",
		Cwd:       parent,
		ToolName:  "Write",
		ToolInput: json.RawMessage(fmt.Sprintf(`{"file_path":%q}`, filepath.Join(fileDir, "mailbox.ts"))),
	}
	stdout := captureStdout(t, func() { handleEditWriteGate(payload) })
	decision, reason := decisionOf(t, stdout)
	if decision != "allow" {
		t.Fatalf("decision = %q, reason = %q, want allow", decision, reason)
	}
}

// Same ambiguous-cwd setup, but nothing onboarded under cwd at all --
// must stay a silent no-op, same as "no coordinator configured".
func TestHandleEditWriteGate_CwdIsParentWithNoOnboardedRepo_SilentNoOp(t *testing.T) {
	parent := t.TempDir()
	sub := filepath.Join(parent, "SomeProject")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	setCachedToken(t, "http://unused.invalid", "")

	payload := hookPayload{
		SessionID: "sess1",
		Cwd:       parent,
		ToolName:  "Write",
		ToolInput: json.RawMessage(fmt.Sprintf(`{"file_path":%q}`, filepath.Join(sub, "foo.go"))),
	}
	stdout := captureStdout(t, func() { handleEditWriteGate(payload) })
	if stdout != "" {
		t.Errorf("stdout = %q, want empty", stdout)
	}
}

// setupMultiRepoCwd creates two independently onboarded repos under one
// non-repo parent directory, both pointing at the same coordinator --
// the common case (one team, several repos, one coordinator) that lets
// handleExitPlanModeMultiCandidate extract the plan just once.
func setupMultiRepoCwd(t *testing.T, serverURL string) (parent, repoA, repoB string) {
	t.Helper()
	parent = t.TempDir()
	repoA = filepath.Join(parent, "TwingMail")
	repoB = filepath.Join(parent, "twinmail-ui")
	for _, dir := range []string{repoA, repoB} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		initTempGitRepoAt(t, dir)
		writeTwingYAML(t, dir, fmt.Sprintf("coordinator:\n  serverUrl: %s\n", serverURL))
	}
	return parent, repoA, repoB
}

func TestHandleExitPlanMode_MultiCandidate_PlanTouchesOnlyOneCandidate_RegistersThereOnly(t *testing.T) {
	var checkCalls, extractCalls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		switch r.URL.Path {
		case "/v1/designs/extract":
			extractCalls++
			_, _ = w.Write([]byte(`{"creates":[],"touches":["TwingMail/packages/api/mailbox.ts"],"dependsOn":[],"summary":"fix mailbox parsing"}`))
		case "/v1/designs/check":
			checkCalls++
			var body designCheckRequest
			_ = json.NewDecoder(r.Body).Decode(&body)
			if len(body.Touches) != 1 || body.Touches[0] != "packages/api/mailbox.ts" {
				t.Errorf("designs/check touches = %v, want [packages/api/mailbox.ts] (prefix stripped)", body.Touches)
			}
			_, _ = w.Write([]byte(`{"verdict":"clean","designId":"d1"}`))
		}
	}))
	defer server.Close()

	parent, _, _ := setupMultiRepoCwd(t, server.URL)
	setCachedToken(t, server.URL, "some-token")

	stdout := captureStdout(t, func() { handleExitPlanMode(planPayload(parent, "sess1")) })
	decision, reason := decisionOf(t, stdout)
	if decision != "allow" {
		t.Fatalf("decision = %q, reason = %q, want allow", decision, reason)
	}
	if extractCalls != 1 {
		t.Errorf("extract calls = %d, want 1 (one coordinator shared by both candidates)", extractCalls)
	}
	if checkCalls != 1 {
		t.Errorf("check calls = %d, want 1 -- only the matching candidate should register", checkCalls)
	}
}

func TestHandleExitPlanMode_MultiCandidate_PlanSpansBothCandidates_RegistersInBoth(t *testing.T) {
	var checkedProjects []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		switch r.URL.Path {
		case "/v1/designs/extract":
			_, _ = w.Write([]byte(`{"creates":[],"touches":["TwingMail/packages/api/mailbox.ts","twinmail-ui/src/Inbox.tsx"],"dependsOn":[],"summary":"full-stack change"}`))
		case "/v1/designs/check":
			var body designCheckRequest
			_ = json.NewDecoder(r.Body).Decode(&body)
			checkedProjects = append(checkedProjects, body.ProjectID)
			_, _ = w.Write([]byte(`{"verdict":"clean","designId":"d1"}`))
		}
	}))
	defer server.Close()

	parent, _, _ := setupMultiRepoCwd(t, server.URL)
	setCachedToken(t, server.URL, "some-token")

	stdout := captureStdout(t, func() { handleExitPlanMode(planPayload(parent, "sess1")) })
	decision, reason := decisionOf(t, stdout)
	if decision != "allow" {
		t.Fatalf("decision = %q, reason = %q, want allow", decision, reason)
	}
	if len(checkedProjects) != 2 || checkedProjects[0] == checkedProjects[1] {
		t.Errorf("checked projects = %v, want two distinct project ids -- one design registered per repo", checkedProjects)
	}
}

// The residual ambiguous case: the plan mentions no concrete path inside
// either candidate. Must deny, not guess-and-register-everywhere.
func TestHandleExitPlanMode_MultiCandidate_NoPathMatchesAnyCandidate_DeniesAmbiguous(t *testing.T) {
	var checkCalls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		switch r.URL.Path {
		case "/v1/designs/extract":
			_, _ = w.Write([]byte(`{"creates":[],"touches":[],"dependsOn":[],"summary":"a vague plan with no concrete paths"}`))
		case "/v1/designs/check":
			checkCalls++
		}
	}))
	defer server.Close()

	parent, _, _ := setupMultiRepoCwd(t, server.URL)
	setCachedToken(t, server.URL, "some-token")

	stdout := captureStdout(t, func() { handleExitPlanMode(planPayload(parent, "sess1")) })
	decision, reason := decisionOf(t, stdout)
	if decision != "deny" {
		t.Fatalf("decision = %q, want deny", decision)
	}
	if !strings.Contains(reason, "TwingMail") || !strings.Contains(reason, "twinmail-ui") {
		t.Errorf("reason = %q, want it to name both candidates", reason)
	}
	if checkCalls != 0 {
		t.Errorf("check calls = %d, want 0 -- nothing should register when nothing matched", checkCalls)
	}
}

// No onboarded repo anywhere under cwd at all -- silent allow, same
// category as the single-repo "no coordinator configured" case.
func TestHandleExitPlanMode_MultiCandidate_NoCandidatesAtAll_SilentNoOp(t *testing.T) {
	parent := t.TempDir()
	if err := os.MkdirAll(filepath.Join(parent, "plain-folder"), 0o755); err != nil {
		t.Fatal(err)
	}

	stdout := captureStdout(t, func() { handleExitPlanMode(planPayload(parent, "sess1")) })
	if stdout != "" {
		t.Errorf("stdout = %q, want empty", stdout)
	}
}

// A denial from one matched candidate must still surface, naming which repo
// it came from, even though the other candidate came back clean.
func TestHandleExitPlanMode_MultiCandidate_OneCandidateDenies_OverallDenies(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		switch r.URL.Path {
		case "/v1/designs/extract":
			_, _ = w.Write([]byte(`{"creates":[],"touches":["TwingMail/packages/api/mailbox.ts","twinmail-ui/src/Inbox.tsx"],"dependsOn":[],"summary":"full-stack change"}`))
		case "/v1/designs/check":
			var body designCheckRequest
			_ = json.NewDecoder(r.Body).Decode(&body)
			if len(body.Touches) == 1 && body.Touches[0] == "src/Inbox.tsx" {
				_, _ = w.Write([]byte(`{"verdict":"overlap","designId":"d2","conflicts":[{"conflictingDesignId":"d-other","overlapKind":"exact_overlap","overlapDetail":"src/Inbox.tsx","conflictingSummary":"another session's inbox work"}]}`))
				return
			}
			_, _ = w.Write([]byte(`{"verdict":"clean","designId":"d1"}`))
		}
	}))
	defer server.Close()

	parent, _, _ := setupMultiRepoCwd(t, server.URL)
	setCachedToken(t, server.URL, "some-token")

	stdout := captureStdout(t, func() { handleExitPlanMode(planPayload(parent, "sess1")) })
	decision, reason := decisionOf(t, stdout)
	if decision != "deny" {
		t.Fatalf("decision = %q, want deny", decision)
	}
	if !strings.Contains(reason, "twinmail-ui") || !strings.Contains(reason, "d-other") {
		t.Errorf("reason = %q, want it to name twinmail-ui and the conflicting design", reason)
	}
}

// 2026-08-19 severity split, multi-candidate counterpart to
// TestHandleExitPlanMode_OverlapWarningSeverity_Allows: one candidate comes
// back "overlap"/"warning" -- must not deny overall, same as if it had come
// back clean.
func TestHandleExitPlanMode_MultiCandidate_OneCandidateWarningSeverity_OverallAllows(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		switch r.URL.Path {
		case "/v1/designs/extract":
			_, _ = w.Write([]byte(`{"creates":[],"touches":["TwingMail/packages/api/mailbox.ts","twinmail-ui/src/Inbox.tsx"],"dependsOn":[],"summary":"full-stack change"}`))
		case "/v1/designs/check":
			var body designCheckRequest
			_ = json.NewDecoder(r.Body).Decode(&body)
			if len(body.Touches) == 1 && body.Touches[0] == "src/Inbox.tsx" {
				_, _ = w.Write([]byte(`{"verdict":"overlap","severity":"warning","designId":"d2","conflicts":[{"conflictingDesignId":"d-other","overlapKind":"touches","overlapDetail":"src/Inbox.tsx","conflictingSummary":"another session's inbox work"}]}`))
				return
			}
			_, _ = w.Write([]byte(`{"verdict":"clean","designId":"d1"}`))
		}
	}))
	defer server.Close()

	parent, _, _ := setupMultiRepoCwd(t, server.URL)
	setCachedToken(t, server.URL, "some-token")

	stdout := captureStdout(t, func() { handleExitPlanMode(planPayload(parent, "sess1")) })
	decision, reason := decisionOf(t, stdout)
	if decision != "allow" {
		t.Fatalf("decision = %q, reason = %q, want allow", decision, reason)
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
