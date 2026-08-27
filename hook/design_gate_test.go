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
	if !strings.Contains(reason, "isn't signed in") {
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
	if !strings.Contains(reason, "sign-in was rejected") {
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
	if !strings.Contains(reason, "can't reach the coordinator") {
		t.Errorf("reason = %q, want it to mention unreachable", reason)
	}
}

func TestHandleEditWriteGate_HookVersionMismatch_Denies(t *testing.T) {
	var gotVersionHeader string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotVersionHeader = r.Header.Get("x-twing-hook-version")
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusUpgradeRequired)
		_, _ = w.Write([]byte(`{"error":"hook_version_mismatch","hookVersion":"dev","serverVersion":"9.9.9"}`))
	}))
	defer server.Close()

	repo := newTestRepo(t, server.URL)
	setCachedToken(t, server.URL, "some-token")

	stdout := captureStdout(t, func() { handleEditWriteGate(editPayload(repo, "sess1")) })
	decision, reason := decisionOf(t, stdout)
	if decision != "deny" {
		t.Fatalf("decision = %q, want deny", decision)
	}
	if !strings.Contains(reason, "out of date") {
		t.Errorf("reason = %q, want it to mention the version mismatch", reason)
	}
	if !strings.Contains(reason, "9.9.9") {
		t.Errorf("reason = %q, want it to name the coordinator's expected version", reason)
	}
	if gotVersionHeader == "" {
		t.Error("outgoing request did not carry x-twing-hook-version")
	}
	// Found live, 2026-08-27, via a real sandboxed test: a Claude Code
	// session that ran exactly "npm install -g @twing/cli@latest && twing
	// daemon restart" (the command this used to suggest) still failed the
	// retry, since neither step refreshes the separately-fetched hook
	// binary -- only `twing init` does. Asserted explicitly so this exact
	// regression can't silently reappear.
	if !strings.Contains(reason, "twing init") {
		t.Errorf("reason = %q, want the remediation command to include `twing init` (not just npm install -g), or the hook binary itself never actually gets refreshed", reason)
	}
}

func TestHandleEditWriteGate_HookAheadOfServer_DeniesWithWaitMessage(t *testing.T) {
	original := version
	version = "9.9.9"
	t.Cleanup(func() { version = original })

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusUpgradeRequired)
		_, _ = w.Write([]byte(`{"error":"hook_version_mismatch","hookVersion":"9.9.9","serverVersion":"0.2.5"}`))
	}))
	defer server.Close()

	repo := newTestRepo(t, server.URL)
	setCachedToken(t, server.URL, "some-token")

	stdout := captureStdout(t, func() { handleEditWriteGate(editPayload(repo, "sess1")) })
	decision, reason := decisionOf(t, stdout)
	if decision != "deny" {
		t.Fatalf("decision = %q, want deny", decision)
	}
	if !strings.Contains(reason, "coordination server needs an update") {
		t.Errorf("reason = %q, want the server-behind message, not the client-behind one", reason)
	}
	if strings.Contains(reason, "npm install") {
		t.Errorf("reason = %q, should not suggest npm install -g when this machine is ahead, not behind", reason)
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
	if !strings.Contains(reason, "didn't understand from the coordinator") {
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
	if !strings.Contains(reason, "needs to know what you're building") {
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

// Found live (2026-08-25): with more than one open design in the session,
// the deny used to silently pick just one (and the *oldest* one, an
// unrelated bug on the server side -- see app.ts's own comment) instead of
// offering every candidate. This is the fix: every open design in
// `openDesigns` gets its own amend command.
func TestHandleEditWriteGate_OutOfScope_MultipleOpenDesigns_OffersEveryOneAsAnAmendCandidate(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/constraints/match":
			_, _ = w.Write([]byte(`{"matched":false}`))
		case "/v1/designs/scope-match":
			_, _ = w.Write([]byte(`{"state":"out_of_scope","designId":"d-newest","openDesigns":[
				{"id":"d-newest","summary":"the current task"},
				{"id":"d-oldest","summary":"an earlier, unrelated task"}
			]}`))
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
	for _, want := range []string{"d-newest", "the current task", "d-oldest", "an earlier, unrelated task"} {
		if !strings.Contains(reason, want) {
			t.Errorf("reason missing %q -- every open design must be offered, not just one\n%s", want, reason)
		}
	}
	if strings.Count(reason, "design amend --id") != 2 {
		t.Errorf("reason should offer exactly 2 amend commands, one per open design:\n%s", reason)
	}
}

func TestOutOfScopeReason_CapsTheListAndFoldsTheRestIntoACount(t *testing.T) {
	candidates := make([]designSummary, 0, maxOutOfScopeCandidates+3)
	for i := 0; i < maxOutOfScopeCandidates+3; i++ {
		candidates = append(candidates, designSummary{ID: fmt.Sprintf("d%d", i), Summary: fmt.Sprintf("task %d", i)})
	}
	reason := outOfScopeReason(candidates[0].ID, "src/net/retry.ts", candidates)

	if got := strings.Count(reason, "design amend --id"); got != maxOutOfScopeCandidates {
		t.Errorf("amend commands = %d, want exactly the cap (%d)", got, maxOutOfScopeCandidates)
	}
	if !strings.Contains(reason, "3 more") {
		t.Errorf("reason should say how many more are hidden (3), got:\n%s", reason)
	}
	if !strings.Contains(reason, "design list --mine --status open") {
		t.Errorf("reason should point at `design list --mine --status open` to see the rest, got:\n%s", reason)
	}
	// The candidates past the cap must not leak into the message at all.
	if strings.Contains(reason, candidates[maxOutOfScopeCandidates].ID) {
		t.Errorf("reason names a candidate past the cap: %q", candidates[maxOutOfScopeCandidates].ID)
	}
}

func TestOutOfScopeReason_SingleCandidate_NoCountingLanguage(t *testing.T) {
	reason := outOfScopeReason("d1", "src/net/retry.ts", []designSummary{{ID: "d1", Summary: "the current task"}})
	if strings.Contains(reason, "more than one") || strings.Contains(reason, "more open plan") {
		t.Errorf("a single candidate must not talk about multiple plans:\n%s", reason)
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
	if !strings.Contains(reason, "isn't signed in") {
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
	if !strings.Contains(reason, "can't reach the coordinator") {
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

// §17 design linking (2026-08): a genuinely single-repo plan (no sibling
// candidates discovered, so handleExitPlanModeSingle handles it, not the
// multi-candidate path) must never invent a groupId -- the server's own
// "group of one" self-assignment is sufficient, nothing to link here.
func TestHandleExitPlanModeSingle_NeverSetsGroupID(t *testing.T) {
	var checkedGroupID string
	var sawCheck bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/designs/check" {
			sawCheck = true
			var body designCheckRequest
			_ = json.NewDecoder(r.Body).Decode(&body)
			checkedGroupID = body.GroupID
		}
		_, _ = w.Write([]byte(`{"verdict":"clean","designId":"d1"}`))
	}))
	defer server.Close()

	repo := newTestRepo(t, server.URL)
	setCachedToken(t, server.URL, "some-token")

	captureStdout(t, func() { handleExitPlanMode(planPayload(repo, "sess1")) })
	if !sawCheck {
		t.Fatal("expected a /v1/designs/check call")
	}
	if checkedGroupID != "" {
		t.Errorf("groupId = %q, want empty -- single-repo plans must not invent a group", checkedGroupID)
	}
}

// 2026-08-26 terminology simplification: blocking is a pure function of
// verdict now -- file_overlap (tier 1's exactOverlap) never blocks, full
// stop, no severity field to consult at all. The conflict is still recorded
// server-side for display, just not gate-relevant.
func TestHandleExitPlanMode_FileOverlap_Allows(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"verdict":"file_overlap","designId":"d1","conflicts":[{"conflictingDesignId":"d-other","overlapKind":"touches","overlapDetail":"both touch shared.ts","conflictingSummary":"another session's work"}]}`))
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

// Companion to the test above -- a stray legacy "severity" field (an older
// coordinator, or one not yet upgraded off the pre-2026-08-26 shape) must be
// ignored rather than reintroducing severity-based branching.
func TestHandleExitPlanMode_FileOverlap_IgnoresStraySeverityField(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"verdict":"file_overlap","severity":"warning","designId":"d1","conflicts":[{"conflictingDesignId":"d-other","overlapKind":"touches","overlapDetail":"summaries are 80% similar","conflictingSummary":"another session's work"}]}`))
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
	var checkedGroupIDs []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		switch r.URL.Path {
		case "/v1/designs/extract":
			_, _ = w.Write([]byte(`{"creates":[],"touches":["TwingMail/packages/api/mailbox.ts","twinmail-ui/src/Inbox.tsx"],"dependsOn":[],"summary":"full-stack change"}`))
		case "/v1/designs/check":
			var body designCheckRequest
			_ = json.NewDecoder(r.Body).Decode(&body)
			checkedProjects = append(checkedProjects, body.ProjectID)
			checkedGroupIDs = append(checkedGroupIDs, body.GroupID)
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
	// §17 design linking (2026-08): both candidates in one plan invocation
	// must share the same non-empty groupId, so the two resulting designs
	// link automatically with no extra agent action.
	if len(checkedGroupIDs) != 2 || checkedGroupIDs[0] == "" || checkedGroupIDs[0] != checkedGroupIDs[1] {
		t.Errorf("checked groupIds = %v, want two equal non-empty values", checkedGroupIDs)
	}
}

// §17 design linking (2026-08): a fresh groupId is minted per
// handleExitPlanMode invocation, never persisted -- two separate
// invocations (e.g. two distinct plans in the same session) must not share
// one.
func TestHandleExitPlanMode_MultiCandidate_MintsAFreshGroupIDPerInvocation(t *testing.T) {
	var checkedGroupIDs []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		switch r.URL.Path {
		case "/v1/designs/extract":
			_, _ = w.Write([]byte(`{"creates":[],"touches":["TwingMail/packages/api/mailbox.ts","twinmail-ui/src/Inbox.tsx"],"dependsOn":[],"summary":"full-stack change"}`))
		case "/v1/designs/check":
			var body designCheckRequest
			_ = json.NewDecoder(r.Body).Decode(&body)
			checkedGroupIDs = append(checkedGroupIDs, body.GroupID)
			_, _ = w.Write([]byte(`{"verdict":"clean","designId":"d1"}`))
		}
	}))
	defer server.Close()

	parent, _, _ := setupMultiRepoCwd(t, server.URL)
	setCachedToken(t, server.URL, "some-token")

	captureStdout(t, func() { handleExitPlanMode(planPayload(parent, "sess1")) })
	captureStdout(t, func() { handleExitPlanMode(planPayload(parent, "sess1")) })

	if len(checkedGroupIDs) != 4 {
		t.Fatalf("checked groupIds = %v, want 4 (2 candidates x 2 invocations)", checkedGroupIDs)
	}
	firstInvocation, secondInvocation := checkedGroupIDs[0], checkedGroupIDs[2]
	if firstInvocation == "" || secondInvocation == "" || firstInvocation == secondInvocation {
		t.Errorf("first invocation groupId = %q, second = %q, want both non-empty and distinct", firstInvocation, secondInvocation)
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
// it came from. 2026-08-26: rewritten from an "overlap" fixture to
// "constraint_violation" -- the only verdict that still blocks and denies
// via constraintReason here (file_overlap never blocks at all now, see the
// multi-candidate switch in handleExitPlanModeMultiCandidate).
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
				_, _ = w.Write([]byte(`{"verdict":"constraint_violation","designId":"d2","constraints":[{"statement":"protected inbox path","type":"constraint"}]}`))
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
	if !strings.Contains(reason, "twinmail-ui") || !strings.Contains(reason, "protected inbox path") {
		t.Errorf("reason = %q, want it to name twinmail-ui and the violated rule", reason)
	}
}

// 2026-08-26 terminology simplification, multi-candidate counterpart to
// TestHandleExitPlanMode_FileOverlap_Allows: one candidate comes back
// "file_overlap" -- must not deny overall, same as if it had come back
// clean, since file_overlap never blocks regardless of any other candidate.
func TestHandleExitPlanMode_MultiCandidate_OneCandidateFileOverlap_OverallAllows(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		switch r.URL.Path {
		case "/v1/designs/extract":
			_, _ = w.Write([]byte(`{"creates":[],"touches":["TwingMail/packages/api/mailbox.ts","twinmail-ui/src/Inbox.tsx"],"dependsOn":[],"summary":"full-stack change"}`))
		case "/v1/designs/check":
			var body designCheckRequest
			_ = json.NewDecoder(r.Body).Decode(&body)
			if len(body.Touches) == 1 && body.Touches[0] == "src/Inbox.tsx" {
				_, _ = w.Write([]byte(`{"verdict":"file_overlap","designId":"d2","conflicts":[{"conflictingDesignId":"d-other","overlapKind":"touches","overlapDetail":"src/Inbox.tsx","conflictingSummary":"another session's inbox work"}]}`))
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

// --- deny message shape (2026-08-24 readability rewrite) ---
//
// The three-layer grammar these assert (plain headline -> detail -> "What
// now") is the whole point of that change: every deny used to open with an
// identifier, which meant a reader couldn't tell a bug from a rule from a
// teammate without parsing internal vocabulary. `allDenyMessages` is
// deliberately exhaustive -- a new *Reason function that isn't listed here
// is the one way this could silently regress.
func allDenyMessages(t *testing.T) map[string]string {
	t.Helper()
	overlap := designCheckResponse{
		DesignID: "11111111-2222-3333-4444-555555555555",
		Conflicts: []designConflict{{
			ConflictingDesignID: "66666666-7777-8888-9999-000000000000",
			OverlapKind:         "exactOverlap",
			OverlapDetail:       "both plans write src/net/http-client.ts",
			ConflictingSummary:  "adds retry with exponential backoff to the API client",
		}},
	}
	constraint := designCheckResponse{
		DesignID:    "11111111-2222-3333-4444-555555555555",
		Constraints: []designConstraintInfo{{Statement: "money paths need a second pair of eyes", Type: "review_required"}},
	}
	return map[string]string{
		"noDesign":              noDesignReason(),
		"flagged":               flaggedDesignReason("11111111-2222-3333-4444-555555555555", false, true, "constraint_violation"),
		"flaggedPendingRev":     flaggedDesignReason("11111111-2222-3333-4444-555555555555", true, true, "constraint_violation"),
		"flaggedSelfApprove":    flaggedDesignReason("11111111-2222-3333-4444-555555555555", false, false, "symbol_conflict"),
		"flaggedSymbolConflict": flaggedDesignReason("11111111-2222-3333-4444-555555555555", false, false, "symbol_conflict"),
		"flaggedLlmDivergence":  flaggedDesignReason("11111111-2222-3333-4444-555555555555", false, false, "llm_divergence"),
		"flaggedLegacyVerdict":  flaggedDesignReason("11111111-2222-3333-4444-555555555555", false, false, ""),
		"outOfScope":         outOfScopeReason("11111111-2222-3333-4444-555555555555", "src/net/retry.ts", nil),
		"outOfScopeMulti": outOfScopeReason("11111111-2222-3333-4444-555555555555", "src/net/retry.ts", []designSummary{
			{ID: "11111111-2222-3333-4444-555555555555", Summary: "add retry with backoff"},
			{ID: "66666666-7777-8888-9999-000000000000", Summary: "unrelated debounce helper"},
		}),
		"dormant":            dormantDesignReason("11111111-2222-3333-4444-555555555555", "adds retry", 7200000),
		"overlap":            overlapReason(overlap),
		"constraint":         constraintReason(constraint),
		"authRequired":       authRequiredReason("https://coordination-server.twing.dev"),
		"authRejected401":    authRejectedReason(http.StatusUnauthorized, "https://coordination-server.twing.dev"),
		"authRejected403":    authRejectedReason(http.StatusForbidden, "https://coordination-server.twing.dev"),
		"unreachable":        unreachableReason(fmt.Errorf("connection refused")),
		"coordinatorError":   coordinatorErrorReason("unexpected status 500"),
		"pathConstraint":     pathConstraintReason("hook/design_gate.go", []designConstraintInfo{{Statement: "the gate's own verdict/deny logic", Type: "review_required"}}),
		"ambiguousMultiRepo": ambiguousMultiRepoReason([]childCoordinator{{DirName: "api"}, {DirName: "web"}}),
	}
}

// The load-bearing assertion of the whole rewrite: layer 1 is a plain
// sentence, so no identifier may appear in it. A UUID in the first line is
// exactly the regression this guards against.
func TestDenyMessages_HeadlineIsPlainSentence(t *testing.T) {
	for name, msg := range allDenyMessages(t) {
		headline := strings.SplitN(msg, "\n", 2)[0]
		if headline == "" {
			t.Errorf("%s: empty headline", name)
			continue
		}
		if strings.Contains(headline, "11111111") || strings.Contains(headline, "66666666") {
			t.Errorf("%s: headline contains an identifier: %q", name, headline)
		}
		if !strings.HasSuffix(headline, ".") {
			t.Errorf("%s: headline should be a sentence, got %q", name, headline)
		}
		if len(headline) > denyWrapWidth+8 {
			t.Errorf("%s: headline too long (%d chars): %q", name, len(headline), headline)
		}
	}
}

// Prose must stay narrow enough for a small terminal. Command lines are
// exempt: a design id is a 36-char UUID, so `twing design resolve --id
// <uuid> --justify "<reason>"` cannot fit and shouldn't be broken.
func TestDenyMessages_ProseLinesStayNarrow(t *testing.T) {
	for name, msg := range allDenyMessages(t) {
		for _, line := range strings.Split(msg, "\n") {
			if strings.Contains(line, "twing ") || strings.Contains(line, "TWING_") {
				continue // a command line
			}
			if len(line) > denyWrapWidth+len(denyCommandIndent) {
				t.Errorf("%s: line too long (%d chars): %q", name, len(line), line)
			}
		}
	}
}

func TestDenyMessages_TellYouWhatToDo(t *testing.T) {
	for name, msg := range allDenyMessages(t) {
		if !strings.Contains(msg, "What now") {
			t.Errorf("%s: no 'What now' section", name)
		}
	}
}

// 401 and 403 are different problems with different fixes. Collapsing them
// cost a real user five days: the message said the token was stale and to
// run `twing login`, when the actual cause was a 403 -- not being a member
// of the project -- which `twing login` cannot fix.
func TestAuthRejectedReason_DistinguishesUnauthorizedFromForbidden(t *testing.T) {
	unauthorized := authRejectedReason(http.StatusUnauthorized, "https://example.com")
	forbidden := authRejectedReason(http.StatusForbidden, "https://example.com")

	if unauthorized == forbidden {
		t.Fatal("401 and 403 must not produce the same message")
	}
	if !strings.Contains(forbidden, "access to this project") {
		t.Errorf("403 should say it's a project-access problem, got %q", forbidden)
	}
	if !strings.Contains(forbidden, "twing whoami") {
		t.Errorf("403 should suggest checking current access, got %q", forbidden)
	}
	if !strings.Contains(unauthorized, "wasn't recognised") && !strings.Contains(unauthorized, "didn't recognise") {
		t.Errorf("401 should say the credentials weren't recognised, got %q", unauthorized)
	}
	for _, msg := range []string{unauthorized, forbidden} {
		if strings.Contains(msg, "twing login") {
			t.Errorf("neither should suggest `twing login` -- it can't fix either case: %q", msg)
		}
	}
}

// A semantic conflict is flagged asynchronously, minutes after a clean
// registration, so the old "conflict from its own registration" wording was
// simply false in the common case.
func TestFlaggedDesignReason_DoesNotClaimConflictCameFromRegistration(t *testing.T) {
	msg := flaggedDesignReason("11111111-2222-3333-4444-555555555555", false, true, "constraint_violation")
	if strings.Contains(msg, "registration") {
		t.Errorf("should not attribute the conflict to registration time: %q", msg)
	}
}

// Tightening alignment threads, item 2 (2026-08-27): a flagged design used
// to only ever offer adopt/justify -- no way to say "this doesn't apply to
// me anymore" even though designs.close() already accepts a flagged design
// unconditionally. Checked across all three flagging verdicts (not just
// one), and only for the not-yet-justified/not-pending-review case -- once
// a justification is already pending or resolving, closing isn't the
// relevant next step.
func TestFlaggedDesignReason_OffersCloseAcrossAllThreeVerdicts(t *testing.T) {
	for _, verdict := range []string{"constraint_violation", "symbol_conflict", "llm_divergence"} {
		msg := flaggedDesignReason("11111111-2222-3333-4444-555555555555", false, false, verdict)
		wantCmd := "twing design close --id 11111111-2222-3333-4444-555555555555"
		if !strings.Contains(msg, wantCmd) {
			t.Errorf("%s: expected a close action (%q), got %q", verdict, wantCmd, msg)
		}
		// Must not replace either existing action -- close is a third
		// option, not a swap.
		if !strings.Contains(msg, "twing design resolve --id 11111111-2222-3333-4444-555555555555 --adopt") {
			t.Errorf("%s: adopt action must still be present alongside close, got %q", verdict, msg)
		}
		if !strings.Contains(msg, "twing design resolve --id 11111111-2222-3333-4444-555555555555 --justify") {
			t.Errorf("%s: justify action must still be present alongside close, got %q", verdict, msg)
		}
	}
}

// Optional fields are genuinely absent in production (a design registered
// without a summary, a zero dormant duration), and must not produce a
// dangling label with no value.
func TestDormantDesignReason_OmitsMissingSummary(t *testing.T) {
	msg := dormantDesignReason("11111111-2222-3333-4444-555555555555", "", 0)
	if strings.Contains(msg, "What it was") {
		t.Errorf("empty summary should be omitted entirely, got %q", msg)
	}
	if !strings.Contains(msg, "What now") {
		t.Errorf("should still render actions, got %q", msg)
	}
}

// The "no design" deny previously offered only "register something new"
// (plan mode, or `design register`) -- a session with an already-open
// design elsewhere in the project (e.g. from earlier the same day) had no
// suggested path to join it instead, which is most of why unrelated small
// fixes ended up as their own untracked designs rather than `--group`-linked
// into the ongoing effort (twing-cli issue, 2026-08-25).
func TestNoDesignReason_SuggestsJoiningAnExistingOpenDesign(t *testing.T) {
	msg := noDesignReason()
	if !strings.Contains(msg, "twing design list --mine --status open") {
		t.Errorf("should point at listing the caller's own open designs, got %q", msg)
	}
	if !strings.Contains(msg, "amend --id") || !strings.Contains(msg, "--group") {
		t.Errorf("should suggest amend --group as the follow-up, got %q", msg)
	}
}

// The agent note is addressed to the agent, not the person reading the
// terminal, so it must be visibly separated from the user-facing text.
func TestDenyOutput_SeparatesAgentNoteFromUserText(t *testing.T) {
	out := denyOutput("PreToolUse", noDesignReason())
	hook := out["hookSpecificOutput"].(map[string]any)
	reason := hook["permissionDecisionReason"].(string)

	if !strings.Contains(reason, "\n---\nNote for the agent:") {
		t.Errorf("agent note should be behind a labelled rule, got %q", reason)
	}
	if strings.Index(reason, "---\nNote for the agent:") < strings.Index(reason, "What now") {
		t.Error("agent note should come after the user-facing content")
	}
}

// There are two constraint denials, not one: constraintReason covers the
// ExitPlanMode path, pathConstraintReason the Edit/Write ground-truth
// backstop. The second was missed in the first pass of the readability
// rewrite (2026-08-24) because it was an inline strings.Builder rather than
// a *Reason function, so it didn't turn up alongside the others -- found
// only by driving the real binary against a real coordinator. This asserts
// both, so a third one can't hide the same way.
func TestBothConstraintPaths_LeadWithPlainSentence(t *testing.T) {
	// Type is still accepted on the wire (backward compat) but 2026-08-26
	// dropped constraintTypeText's per-type phrase entirely -- there's only
	// one DesignConstraintType value now, so the rule's own statement text
	// is what carries the substance, not a type-derived phrase.
	rules := []designConstraintInfo{{Statement: "money paths need a second pair of eyes", Type: "review_required"}}

	planPath := constraintReason(designCheckResponse{DesignID: "11111111-2222-3333-4444-555555555555", Constraints: rules})
	editPath := pathConstraintReason("src/billing/charge.ts", rules)

	for name, msg := range map[string]string{"ExitPlanMode": planPath, "Edit/Write": editPath} {
		headline := strings.SplitN(msg, "\n", 2)[0]
		if strings.HasPrefix(headline, "twing design coordinator:") {
			t.Errorf("%s: still leads with the old machine-facing prefix: %q", name, headline)
		}
		if !strings.Contains(msg, "What now") {
			t.Errorf("%s: no 'What now' section", name)
		}
		if !strings.Contains(msg, "money paths need a second pair of eyes") {
			t.Errorf("%s: the rule's own statement text is missing", name)
		}
		if strings.Contains(msg, "review_required") {
			t.Errorf("%s: raw constraint type leaked into the message untranslated: %q", name, msg)
		}
	}

	// The Edit/Write path names the specific file; the plan path does not.
	if !strings.Contains(editPath, "src/billing/charge.ts") {
		t.Error("Edit/Write path should name the file being written")
	}
}
