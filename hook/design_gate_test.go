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
	// repoScopeFlag is process-global (design_gate.go) because a real hook
	// process handles exactly one event for one repo. Tests share a process,
	// so without this a run that legitimately sets it leaks `-C <its repo>`
	// into the deny text of every later test in the file.
	repoScopeFlag, currentRepoRoot = "", ""
	t.Cleanup(func() { repoScopeFlag, currentRepoRoot = "", "" })
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

// planPayload carries plan text that names files in both fixture repos.
//
// Candidate repos are resolved from the paths the plan itself mentions
// (plan_paths.go), so a plan naming nothing resolves to nothing -- which is
// correct behaviour, and also what a real plan never looks like. The
// multi-repo tests below need a plan that reads like one.
func planPayload(cwd, sessionID string) hookPayload {
	return planPayloadWith(cwd, sessionID,
		"do the thing, touching TwingMail/packages/api/mailbox.ts and twinmail-ui/src/app.ts")
}

// planPayloadWith is planPayload with the plan text spelled out, for tests
// about which repos a given plan resolves to.
func planPayloadWith(cwd, sessionID, plan string) hookPayload {
	body, err := json.Marshal(map[string]string{"plan": plan})
	if err != nil {
		panic(err)
	}
	return hookPayload{
		SessionID: sessionID,
		Cwd:       cwd,
		ToolName:  "ExitPlanMode",
		ToolInput: body,
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
	// A machine someone installed twing on: there, naming the three commands
	// is right, because they exist and work. The managed counterpart is
	// TestHookVersionMismatchReason_ManagedInstallNamesNoCommand below.
	pinInstallKind(t, false)
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
	// Managed: self-heal already tried this exact upgrade-or-downgrade and
	// failed, so this stays direction-agnostic -- no runnable command
	// either way, just the log. See
	// TestHookVersionMismatchReason_ManagedAheadMatchesManagedBehind for the
	// unit-level version of this same claim; a self-installed machine that
	// is ahead gets a materially different (and runnable) message instead --
	// see TestHandleEditWriteGate_SelfInstalledAheadOfServer_DeniesWithDowngradeCommand.
	pinInstallKind(t, true)
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
	if !strings.Contains(reason, "design-coordinator.log") {
		t.Errorf("reason = %q, want the managed operational-failure message, pointing at the log", reason)
	}
	if strings.Contains(reason, "npm install") {
		t.Errorf("reason = %q, should not suggest npm install -g on a managed install -- there is nothing on PATH to run it", reason)
	}
}

// A self-installed machine that is ahead of the coordinator gets a real,
// runnable fix -- downgrade to match -- unlike the managed case above,
// since self-heal never touches a self-installed machine in either
// direction.
func TestHandleEditWriteGate_SelfInstalledAheadOfServer_DeniesWithDowngradeCommand(t *testing.T) {
	pinInstallKind(t, false)
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
	if !strings.Contains(reason, "npm install -g @twing/cli@0.2.5") {
		t.Errorf("reason = %q, want a downgrade command pinned to the coordinator's exact version", reason)
	}
	if strings.Contains(reason, "an operator needs to redeploy the coordinator") {
		t.Errorf("reason = %q, must not blame the coordinator for this machine's own over-install", reason)
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

// additionalContextOf pulls hookSpecificOutput.additionalContext out of a
// captured stdout payload, "" if absent -- allowOutputWithContext's own
// field, distinct from decisionOf's permissionDecision/reason pair.
func additionalContextOf(t *testing.T, stdout string) string {
	t.Helper()
	if stdout == "" {
		return ""
	}
	var parsed struct {
		HookSpecificOutput struct {
			AdditionalContext string `json:"additionalContext"`
		} `json:"hookSpecificOutput"`
	}
	if err := json.Unmarshal([]byte(stdout), &parsed); err != nil {
		t.Fatalf("stdout not valid JSON: %v\n%s", err, stdout)
	}
	return parsed.HookSpecificOutput.AdditionalContext
}

// Change A (2026-08-31): a silent successful registration was exactly how
// the incident that led to this whole file's changes went undetected --
// see allowOutputWithContext's own doc comment.
func TestHandleExitPlanMode_CleanVerdict_ReportsWhatItRegistered(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"verdict":"clean","designId":"d1"}`))
	}))
	defer server.Close()

	repo := newTestRepo(t, server.URL)
	setCachedToken(t, server.URL, "some-token")

	stdout := captureStdout(t, func() { handleExitPlanMode(planPayload(repo, "sess1")) })
	ctx := additionalContextOf(t, stdout)
	if !strings.Contains(ctx, "registered design d1 for project") {
		t.Fatalf("additionalContext = %q, want it to name the registered design and project", ctx)
	}
}

// Change C (2026-08-31): the existence-check advisory. computeProjectID
// requires a real git remote to produce a stable id, but that's incidental
// here -- the check only cares whether declared `touches` exist under
// repoRoot, so any value flowing through is fine.
func TestHandleExitPlanMode_WarnsWhenNoDeclaredTouchesExist(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"verdict":"clean","designId":"d1","touches":["src/does-not-exist.go"]}`))
	}))
	defer server.Close()

	repo := newTestRepo(t, server.URL)
	setCachedToken(t, server.URL, "some-token")

	stdout := captureStdout(t, func() { handleExitPlanMode(planPayload(repo, "sess1")) })
	ctx := additionalContextOf(t, stdout)
	if !strings.Contains(ctx, "none of this design's declared files exist") {
		t.Fatalf("additionalContext = %q, want the existence-check warning", ctx)
	}
	if !strings.Contains(ctx, "--reassign-project") || !strings.Contains(ctx, "--group") {
		t.Fatalf("additionalContext = %q, want both suggested commands (move / multi-repo link)", ctx)
	}
}

func TestHandleExitPlanMode_NoWarningWhenADeclaredTouchExists(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"verdict":"clean","designId":"d1","touches":["real.go","also-missing.go"]}`))
	}))
	defer server.Close()

	repo := newTestRepo(t, server.URL)
	if err := os.WriteFile(filepath.Join(repo, "real.go"), []byte("package main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	setCachedToken(t, server.URL, "some-token")

	stdout := captureStdout(t, func() { handleExitPlanMode(planPayload(repo, "sess1")) })
	ctx := additionalContextOf(t, stdout)
	if strings.Contains(ctx, "none of this design's declared files exist") {
		t.Fatalf("additionalContext = %q, want no warning -- one real match is enough", ctx)
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
// An ExitPlanMode deny blocks *planning*, when nothing has been changed yet,
// so it protects nothing. These three cases all allow, and rely on the Edit
// gate -- which denies with "no design registered" -- to be the real backstop.

func TestHandleExitPlanMode_MultiCandidate_ExtractionMatchesNothing_AllowsAndLetsTheEditGateDemandADesign(t *testing.T) {
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
	if stdout != "" {
		t.Fatalf("stdout = %q, want silence -- denying a plan protects nothing", stdout)
	}
	if checkCalls != 0 {
		t.Errorf("check calls = %d, want 0 -- registering in every candidate unfiltered would be a guess", checkCalls)
	}
}

func TestHandleExitPlanMode_PlanNamesNoResolvablePath_AllowsSilently(t *testing.T) {
	// The case that used to be invisible: a session rooted outside any twing
	// repo, with a plan naming nothing. Previously the child scan found no
	// candidates and returned silently; now the *plan* resolves to none. Same
	// outcome, reached honestly.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("no coordinator should be contacted when the plan resolves to no repo")
		w.WriteHeader(500)
	}))
	defer server.Close()

	parent, _, _ := setupMultiRepoCwd(t, server.URL)
	setCachedToken(t, server.URL, "some-token")

	stdout := captureStdout(t, func() {
		handleExitPlanMode(planPayloadWith(parent, "sess1", "rework the mailbox parsing, carefully"))
	})
	if stdout != "" {
		t.Fatalf("stdout = %q, want silence", stdout)
	}
}

func TestHandleExitPlanMode_PlanFindsRepoAtDepth_WhichTheOldChildScanCouldNot(t *testing.T) {
	// discoverChildCoordinators scanned exactly one level, so a repo nested
	// any deeper was invisible. Resolving upward from the plan's own paths
	// finds it at any depth.
	var checked bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		switch r.URL.Path {
		case "/v1/designs/extract":
			_, _ = w.Write([]byte(`{"creates":[],"touches":["team/nested/auth/src/login.ts"],"dependsOn":[],"summary":"s"}`))
		case "/v1/designs/check":
			checked = true
			var body designCheckRequest
			_ = json.NewDecoder(r.Body).Decode(&body)
			if len(body.Touches) != 1 || body.Touches[0] != "src/login.ts" {
				t.Errorf("touches = %v, want [src/login.ts] made repo-relative", body.Touches)
			}
			_, _ = w.Write([]byte(`{"verdict":"clean","designId":"d1"}`))
		}
	}))
	defer server.Close()

	parent := t.TempDir()
	deep := filepath.Join(parent, "team", "nested", "auth")
	if err := os.MkdirAll(filepath.Join(deep, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	initTempGitRepoAt(t, deep)
	writeTwingYAML(t, deep, fmt.Sprintf("coordinator:\n  serverUrl: %s\n", server.URL))
	setCachedToken(t, server.URL, "some-token")

	captureStdout(t, func() {
		handleExitPlanMode(planPayloadWith(parent, "sess1", "edit team/nested/auth/src/login.ts"))
	})
	if !checked {
		t.Error("a repo three levels down must be found -- this is what the one-level child scan missed")
	}
}

func TestHandleExitPlanMode_PlanSpansTwoCoordinators_Denies(t *testing.T) {
	// One machine, one hook binary, one stamped version, and exact version
	// matching -- so two coordinators can never both be satisfied. Refuse the
	// plan rather than half-register and leave a repo permanently blocked.
	serverA := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(500) }))
	defer serverA.Close()
	serverB := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(500) }))
	defer serverB.Close()

	parent := t.TempDir()
	for dir, url := range map[string]string{"auth": serverA.URL, "billing": serverB.URL} {
		repo := filepath.Join(parent, dir)
		if err := os.MkdirAll(filepath.Join(repo, "src"), 0o755); err != nil {
			t.Fatal(err)
		}
		initTempGitRepoAt(t, repo)
		writeTwingYAML(t, repo, fmt.Sprintf("coordinator:\n  serverUrl: %s\n", url))
		setCachedToken(t, url, "some-token")
	}

	stdout := captureStdout(t, func() {
		handleExitPlanMode(planPayloadWith(parent, "sess1", "touch auth/src/a.ts and billing/src/b.ts"))
	})
	decision, reason := decisionOf(t, stdout)
	if decision != "deny" {
		t.Fatalf("decision = %q, want deny", decision)
	}
	flat := strings.Join(strings.Fields(reason), " ")
	if !strings.Contains(flat, "across two coordination servers") {
		t.Errorf("reason should say plainly that this isn't supported: %s", flat)
	}
	if !strings.Contains(reason, serverA.URL) || !strings.Contains(reason, serverB.URL) {
		t.Errorf("reason must name both coordinators: %s", reason)
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
		"noDesign":              noDesignReason("src/net/retry.ts"),
		"flagged":               flaggedDesignReason(designScopeMatchResponse{DesignID: "11111111-2222-3333-4444-555555555555", PendingReview: false, RequiresAdmin: true, Verdict: "constraint_violation"}),
		"flaggedPendingRev":     flaggedDesignReason(designScopeMatchResponse{DesignID: "11111111-2222-3333-4444-555555555555", PendingReview: true, RequiresAdmin: true, Verdict: "constraint_violation"}),
		"flaggedSelfApprove":    flaggedDesignReason(designScopeMatchResponse{DesignID: "11111111-2222-3333-4444-555555555555", PendingReview: false, RequiresAdmin: false, Verdict: "symbol_conflict"}),
		"flaggedSymbolConflict": flaggedDesignReason(designScopeMatchResponse{DesignID: "11111111-2222-3333-4444-555555555555", PendingReview: false, RequiresAdmin: false, Verdict: "symbol_conflict"}),
		"flaggedLlmDivergence":  flaggedDesignReason(designScopeMatchResponse{DesignID: "11111111-2222-3333-4444-555555555555", PendingReview: false, RequiresAdmin: false, Verdict: "llm_divergence"}),
		"flaggedLegacyVerdict":  flaggedDesignReason(designScopeMatchResponse{DesignID: "11111111-2222-3333-4444-555555555555", PendingReview: false, RequiresAdmin: false, Verdict: ""}),
		"outOfScope":            outOfScopeReason("11111111-2222-3333-4444-555555555555", "src/net/retry.ts", nil),
		"outOfScopeMulti": outOfScopeReason("11111111-2222-3333-4444-555555555555", "src/net/retry.ts", []designSummary{
			{ID: "11111111-2222-3333-4444-555555555555", Summary: "add retry with backoff"},
			{ID: "66666666-7777-8888-9999-000000000000", Summary: "unrelated debounce helper"},
		}),
		"dormant":          dormantDesignReason("11111111-2222-3333-4444-555555555555", "adds retry", 7200000),
		"overlap":          overlapReason(overlap),
		"constraint":       constraintReason(constraint),
		"authRequired":     authRequiredReason("https://coordination-server.twing.dev"),
		"authRejected401":  authRejectedReason(http.StatusUnauthorized, "https://coordination-server.twing.dev"),
		"authRejected403":  authRejectedReason(http.StatusForbidden, "https://coordination-server.twing.dev"),
		"unreachable":      unreachableReason(fmt.Errorf("connection refused")),
		"coordinatorError": coordinatorErrorReason("unexpected status 500"),
		"pathConstraint":   pathConstraintReason("hook/design_gate.go", []designConstraintInfo{{Statement: "the gate's own verdict/deny logic", Type: "review_required"}}),
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

// pinInstallKind fixes whether the deny messages treat this machine as one
// twing set itself up on (managed) or one someone installed twing on
// (self-installed). Without it these assertions read the ambient machine and
// pass or fail depending on whose box they run on -- a contributor with a
// bootstrapped ~/.twing/bin/twing gets different text than CI.
// flattenMessage collapses the deny renderer's line wrapping, so an
// assertion can name a phrase without having to know where the wrap
// happens to fall -- which changes whenever the surrounding wording does.
func flattenMessage(msg string) string {
	return strings.Join(strings.Fields(msg), " ")
}

func pinInstallKind(t *testing.T, managed bool) {
	t.Helper()
	original := isManagedInstall
	isManagedInstall = func() bool { return managed }
	t.Cleanup(func() { isManagedInstall = original })
	// Pin Node too. hookVersionMismatchReason consults nodeCanRunCLI, so
	// without this every deny-message test below would quietly depend on the
	// Node of whoever runs the suite. Usable by default -- the too-old case
	// is a deliberate opt-in via pinNodeUsable.
	pinNodeUsable(t, true)
}

func pinNodeUsable(t *testing.T, usable bool) {
	t.Helper()
	original := nodeCanRunCLI
	nodeCanRunCLI = func() bool { return usable }
	t.Cleanup(func() { nodeCanRunCLI = original })
}

// 401 and 403 are different problems with different fixes. Collapsing them
// cost a real user five days: the message said the token was stale and to
// run `twing login`, when the actual cause was a 403 -- not being a member
// of the project -- which `twing login` cannot fix.
func TestAuthRejectedReason_DistinguishesUnauthorizedFromForbidden(t *testing.T) {
	pinInstallKind(t, false) // a machine where `twing whoami` is real
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
	msg := flaggedDesignReason(designScopeMatchResponse{DesignID: "11111111-2222-3333-4444-555555555555", PendingReview: false, RequiresAdmin: true, Verdict: "constraint_violation"})
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
		msg := flaggedDesignReason(designScopeMatchResponse{DesignID: "11111111-2222-3333-4444-555555555555", Verdict: verdict})
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
	msg := noDesignReason("src/net/retry.ts")
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
	out := denyOutput("PreToolUse", noDesignReason("src/net/retry.ts"))
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

// --- what a machine that never installed twing is told ----------------------
//
// The whole point of the committed bootstrap hook is that nobody runs a
// twing command. A deny that then hands the agent three commands is not
// just unhelpful there, it is unrunnable: `npm install -g` needs sudo on a
// system-Node box and there is no `twing` on PATH at all. Found live -- the
// agent refused, correctly, and the developer stayed blocked.

func TestHookVersionMismatchReason_ManagedInstallNamesNoCommand(t *testing.T) {
	pinInstallKind(t, true)
	msg := flattenMessage(hookVersionMismatchReason("0.2.19", "0.2.20"))

	for _, forbidden := range []string{"npm install", "twing init", "twing daemon restart"} {
		if strings.Contains(msg, forbidden) {
			t.Errorf("managed install must not be told to run %q: %s", forbidden, msg)
		}
	}
	if !strings.Contains(msg, "couldn't fix itself") {
		t.Errorf("should say the automatic fix failed, got: %s", msg)
	}
	if !strings.Contains(msg, "operational failure") {
		t.Errorf("should frame this as operational, not as a task for the agent: %s", msg)
	}
	if !strings.Contains(msg, "design-coordinator.log") {
		t.Errorf("should point at the log that has the real cause: %s", msg)
	}
	// Both versions still have to be visible -- that is what makes the
	// report actionable for whoever runs the repo.
	if !strings.Contains(msg, "0.2.19") || !strings.Contains(msg, "0.2.20") {
		t.Errorf("should still name both versions: %s", msg)
	}
}

func TestHookVersionMismatchReason_SelfInstalledKeepsTheRunnableCommands(t *testing.T) {
	pinInstallKind(t, false)
	msg := flattenMessage(hookVersionMismatchReason("0.2.19", "0.2.20"))

	// On a machine where someone chose to install twing, asking them to
	// update is fine and the commands genuinely work. `twing init` in
	// particular must stay: neither npm install -g nor daemon restart
	// refreshes the separately-fetched hook binary, which is what actually
	// sends the version this gate checks (found live, 2026-08-27). Pinned
	// to the coordinator's exact version, not `latest` -- npm's latest can
	// itself be ahead of what this coordinator is running, and a machine
	// that copy-pasted `@latest` here would land ahead instead of matching
	// (found 2026-09-10, working through the ahead/behind cases by hand).
	for _, want := range []string{"npm install -g @twing/cli@0.2.20", "twing init", "twing daemon restart"} {
		if !strings.Contains(msg, want) {
			t.Errorf("self-installed machine should still be told to run %q: %s", want, msg)
		}
	}
	if strings.Contains(msg, "@latest") {
		t.Error("must not suggest @latest -- it can be ahead of this specific coordinator")
	}
}

// Pinning to serverVersion regressed on exactly the input
// hookVersionMismatchReasonFromResponse can actually produce: "unknown", its
// sentinel for an empty/malformed 426 body. `@unknown` would 404 off npm --
// worse than the `@latest` this replaced, which always installed something.
// Found by code review, 2026-09-10.
func TestHookVersionMismatchReason_UnparseableServerVersionFallsBackToLatest(t *testing.T) {
	pinInstallKind(t, false)
	msg := flattenMessage(hookVersionMismatchReason("0.2.19", "unknown"))

	if !strings.Contains(msg, "npm install -g @twing/cli@latest") {
		t.Errorf("an unparseable server version must fall back to @latest, not name it literally: %s", msg)
	}
	if strings.Contains(msg, "@unknown") {
		t.Errorf("must never produce an uninstallable @unknown command: %s", msg)
	}
}

// The mirror image of the test above: a self-installed machine that is
// *ahead* of the coordinator (most likely `npm install -g @twing/cli@latest`
// running at a moment npm's latest had already passed this coordinator) has
// exactly the same fix available as the behind case -- downgrade to match --
// and self-heal never touches a self-installed machine either way, so
// unlike the managed-ahead case this one really does need a runnable
// command, not just a "wait" message.
func TestHookVersionMismatchReason_SelfInstalledAheadIsToldToDowngrade(t *testing.T) {
	pinInstallKind(t, false)
	msg := flattenMessage(hookVersionMismatchReason("0.2.21", "0.2.20"))

	if !strings.Contains(msg, "npm install -g @twing/cli@0.2.20") {
		t.Errorf("should be told to downgrade to the coordinator's exact version: %s", msg)
	}
	if strings.Contains(msg, "an operator needs to redeploy the coordinator") {
		t.Errorf("must not blame the coordinator -- this machine over-installed, not the server: %s", msg)
	}
}

// The managed case stays direction-agnostic: self-heal (version_recovery.go)
// already tried and failed regardless of which way the mismatch runs, so
// "ahead" and "behind" are the same operational story and must produce the
// same kind of message -- no runnable command, point at the log.
func TestHookVersionMismatchReason_ManagedAheadMatchesManagedBehind(t *testing.T) {
	pinInstallKind(t, true)
	ahead := flattenMessage(hookVersionMismatchReason("0.2.21", "0.2.20"))
	behind := flattenMessage(hookVersionMismatchReason("0.2.19", "0.2.20"))

	for name, msg := range map[string]string{"ahead": ahead, "behind": behind} {
		if !strings.Contains(msg, "design-coordinator.log") {
			t.Errorf("%s: should point at the log, not a command: %s", name, msg)
		}
		if strings.Contains(msg, "npm install") {
			t.Errorf("%s: must not name npm install -- self-heal already tried and there is nothing on PATH: %s", name, msg)
		}
	}
}

func TestAuthReasons_ManagedInstallPointAtGhNotTwing(t *testing.T) {
	pinInstallKind(t, true)

	// authRejectedReason's two cases are genuinely different from
	// authRequiredReason below: an *existing* token that is merely stale or
	// valid for the wrong project has no self-serve fix that skips GitHub
	// auth, so these still point only at gh auth login (+ the escape hatch)
	// and must not name a twing command with nothing on PATH to run it.
	for name, msg := range map[string]string{
		"authRejected401": flattenMessage(authRejectedReason(http.StatusUnauthorized, "https://example.com")),
		"authRejected403": flattenMessage(authRejectedReason(http.StatusForbidden, "https://example.com")),
	} {
		if !strings.Contains(msg, "gh auth login") {
			t.Errorf("%s: should name the credential twing actually needs: %s", name, msg)
		}
		for _, forbidden := range []string{"twing login", "twing init", "twing join", "twing whoami"} {
			if strings.Contains(msg, forbidden) {
				t.Errorf("%s: must not name %q on a machine with no twing on PATH: %s", name, forbidden, msg)
			}
		}
		// The escape hatch survives -- it is the one thing that works
		// regardless of how twing got here.
		if !strings.Contains(msg, "TWING_DESIGN_GATE=off") {
			t.Errorf("%s: should keep the gate-off escape hatch: %s", name, msg)
		}
	}
}

// Unlike authRejectedReason above, "never signed in at all" has two genuine
// self-serve fixes that need no GitHub auth: an invite (first time using
// twing here) or a previously-saved PAT (this machine's twing state was
// reset, e.g. by `twing uninstall`). Both resolve through
// withResolvedTwingCLI to the real shim path -- ensureCliShim() in init.ts
// runs before identity resolution can fail, so unlike the "nothing on PATH"
// premise the test above still holds for, the shim is always present by the
// time this message can fire.
func TestAuthRequiredReason_ManagedInstallOffersInviteAndSavedPAT(t *testing.T) {
	pinInstallKind(t, true)
	msg := flattenMessage(authRequiredReason("https://example.com"))

	if !strings.Contains(msg, "gh auth login") {
		t.Errorf("should still lead with the GitHub credential: %s", msg)
	}
	for _, want := range []string{"init --invite", "login --token", "save it somewhere safe", "TWING_DESIGN_GATE=off"} {
		if !strings.Contains(msg, want) {
			t.Errorf("should offer %q: %s", want, msg)
		}
	}
	for _, forbidden := range []string{"twing join", "twing whoami"} {
		if strings.Contains(msg, forbidden) {
			t.Errorf("must not name unrelated command %q: %s", forbidden, msg)
		}
	}
}

// The no-design deny is the single most-travelled registration path there
// is -- it is what a blocked agent is told to run. Before 2026-09 it handed
// back `--summary "<the goal>" --touches <files>`, which can only produce a
// prose blob plus a bag of paths: nothing downstream can check a diff
// against that. These four assert the structured replacement, because a
// regression here silently returns the common path to the unusable shape.
func TestNoDesignReason_OffersAStructuredTemplate(t *testing.T) {
	msg := noDesignReason("src/net/retry.ts")
	for _, want := range []string{
		"design register --from - <<'YAML'",
		"goal:",
		"changes:",
		"action: modify",
		"intent:",
		"YAML",
	} {
		if !strings.Contains(msg, want) {
			t.Errorf("deny should hand back a fillable template, missing %q in:\n%s", want, msg)
		}
	}
}

// The gate already knows which file it refused. Making the reader retype it
// is friction, and a retyped path is a path that can be typo'd.
func TestNoDesignReason_PreFillsTheDeniedPath(t *testing.T) {
	msg := noDesignReason("packages/core/src/identity.ts")
	if !strings.Contains(msg, "target: packages/core/src/identity.ts") {
		t.Errorf("target should be pre-filled with the denied path, got:\n%s", msg)
	}
}

// Real Edit payloads always carry file_path, but a deny that renders
// "target: " with nothing after it would hand back invalid YAML -- a
// helpful message turning into a second failure.
func TestNoDesignReason_PlaceholderWhenNoPathIsKnown(t *testing.T) {
	msg := noDesignReason("")
	if strings.Contains(msg, "target: \n") || strings.Contains(msg, "target:  ") {
		t.Errorf("empty path must not render a bare `target:`, got:\n%s", msg)
	}
	if !strings.Contains(msg, "target: <path, or path::Symbol.method>") {
		t.Errorf("expected a placeholder target, got:\n%s", msg)
	}
}

// The old form appended a bare path, throwing away *why* the file is part
// of the work -- the one thing only the person editing it knows, and the
// one thing a later reviewer needs.
func TestOutOfScopeReason_AppendsAStructuredChange(t *testing.T) {
	msg := outOfScopeReason("11111111-2222-3333-4444-555555555555", "src/net/retry.ts",
		[]designSummary{{ID: "11111111-2222-3333-4444-555555555555", Summary: "add retry to HttpClient"}})
	for _, want := range []string{
		"design amend --id 11111111-2222-3333-4444-555555555555 --from - <<'YAML'",
		"changes:",
		"target: src/net/retry.ts",
		"intent:",
	} {
		if !strings.Contains(msg, want) {
			t.Errorf("out-of-scope deny should append a structured change, missing %q in:\n%s", want, msg)
		}
	}
	if strings.Contains(msg, "--touches src/net/retry.ts") {
		t.Errorf("the bare --touches form should be gone, got:\n%s", msg)
	}
}

// A template whose indentation was reflowed is no longer valid YAML. Block
// lines must survive the formatter exactly as written -- this is why they
// are a separate field from Command rather than an embedded newline string.
func TestDenyMessage_BlockLinesAreNotReflowed(t *testing.T) {
	msg := denyMessage("head", "why", nil, []denyAction{{
		Label: "do it",
		Block: []string{"line one", "  indented two", "", "line three"},
	}})
	for _, want := range []string{
		denyCommandIndent + "line one",
		denyCommandIndent + "  indented two",
		denyCommandIndent + "line three",
	} {
		if !strings.Contains(msg, want) {
			t.Errorf("block line lost its exact indentation, missing %q in:\n%s", want, msg)
		}
	}
	if strings.Contains(msg, denyCommandIndent+"\n") {
		t.Errorf("a blank block line became trailing whitespace:\n%q", msg)
	}
}

// A summary accumulates: amend appends a dated `Update:` entry rather than
// replacing. Rendered through %q that becomes one enormous label full of
// literal \n, burying the command underneath it. Found live once the
// structured-append deny started folding change items into summaries.
func TestSummaryLabel_FirstLineOnlyAndTruncated(t *testing.T) {
	multi := "Add retry to HttpClient\n\nUpdate (2026-09-14): also touches the queue worker"
	if got := summaryLabel(multi); got != "Add retry to HttpClient" {
		t.Errorf("should keep only the first line, got %q", got)
	}
	long := strings.Repeat("x", maxSummaryLabel+40)
	got := summaryLabel(long)
	if len([]rune(got)) > maxSummaryLabel+3 {
		t.Errorf("should truncate, got %d runes", len([]rune(got)))
	}
	if !strings.HasSuffix(got, "...") {
		t.Errorf("truncation should be visible, got %q", got)
	}
	// Multi-byte must not be cut mid-rune.
	if strings.Contains(summaryLabel(strings.Repeat("é", maxSummaryLabel+10)), "�") {
		t.Error("truncation produced a replacement character")
	}
}

func TestOutOfScopeReason_LabelDoesNotCarryLiteralNewlines(t *testing.T) {
	msg := outOfScopeReason("11111111-2222-3333-4444-555555555555", "README.md",
		[]designSummary{{ID: "11111111-2222-3333-4444-555555555555", Summary: "Add retry\n\nUpdate: and more"}})
	if strings.Contains(msg, `\n`) {
		t.Errorf("a multi-line summary leaked escaped newlines into the label:\n%s", msg)
	}
}

// A managed machine refused the update because its Node is below the floor
// used to fall through to the generic "couldn't fix itself" message, whose
// named causes are network, registry reachability, disk and timeout -- none
// of them true, and no mention of Node at all. A reader handed four wrong
// causes picks the plausible one; the real reason was only ever in
// design-coordinator.log, which that message asks them to read but which
// nobody reads before reporting what the deny said.
//
// Written against the 1.0.0 floor move (20.0 -> 22.5), which is the first
// release where a previously-working machine can be refused for this reason.
func TestHookVersionMismatchReason_TooOldNodeNamesNodeAsTheCause(t *testing.T) {
	pinInstallKind(t, true)
	pinNodeUsable(t, false)

	msg := flattenMessage(hookVersionMismatchReason("1.0.0", "1.1.0"))

	if !strings.Contains(msg, "Node") {
		t.Fatalf("the deny must name Node as the cause, got: %s", msg)
	}
	if !strings.Contains(msg, minNodeVersionString()) {
		t.Errorf("must name the required Node version %q, got: %s", minNodeVersionString(), msg)
	}
	// The generic cause list is actively misleading here: every item in it is
	// false, and each one sends the reader somewhere real but wrong.
	for _, forbidden := range []string{"no network/DNS", "npm registry", "disk full", "3-minute budget"} {
		if strings.Contains(msg, forbidden) {
			t.Errorf("must not offer %q as a cause when Node is the known cause: %s", forbidden, msg)
		}
	}
	// Same contract the rest of the managed-install denies hold to.
	for _, forbidden := range []string{"npm install", "twing init", "twing daemon restart"} {
		if strings.Contains(msg, forbidden) {
			t.Errorf("a managed install must not be told to run %q: %s", forbidden, msg)
		}
	}
	if !strings.Contains(msg, "operational problem") {
		t.Errorf("should frame it as operational, not something the agent works around: %s", msg)
	}
}

// The counterpart: a usable Node must still get the generic message. The new
// branch is meant to catch one specific cause, not to swallow every mismatch.
func TestHookVersionMismatchReason_UsableNodeKeepsTheGenericCauses(t *testing.T) {
	pinInstallKind(t, true)
	pinNodeUsable(t, true)

	msg := flattenMessage(hookVersionMismatchReason("1.0.0", "1.1.0"))

	if strings.Contains(msg, "Node is too old") {
		t.Errorf("Node is not the cause here and must not be named: %s", msg)
	}
	if !strings.Contains(msg, "couldn't fix itself") {
		t.Errorf("should still be the generic self-heal-failed message, got: %s", msg)
	}
}

// A self-installed machine never runs version recovery at all, so the Node
// floor is not why it is mismatched -- it must keep getting the commands to
// run rather than being told to upgrade Node and wait for a self-heal that
// will never come.
func TestHookVersionMismatchReason_SelfInstalledIsUnaffectedByNodeFloor(t *testing.T) {
	pinInstallKind(t, false)
	pinNodeUsable(t, false)

	msg := flattenMessage(hookVersionMismatchReason("1.0.0", "1.1.0"))

	if !strings.Contains(msg, "npm install") {
		t.Errorf("a self-installed machine still has something to run, got: %s", msg)
	}
}

// The comparator's explanation reaching the deny (2026-09-19). Before this,
// a blocked session was told *that* it conflicted and not what with: the
// explanation existed, but only in the alignment thread, so learning
// anything meant running a second command.
func TestFlaggedDesignReason_CarriesTheComparatorsReasonAndCounterpart(t *testing.T) {
	msg := flaggedDesignReason(designScopeMatchResponse{
		DesignID:            "11111111-2222-3333-4444-555555555555",
		Verdict:             "llm_divergence",
		ConflictingDesignID: "99999999-8888-7777-6666-555555555555",
		ConflictSummary:     "Add a per-user rate limiter in the API gateway",
		ConflictReason:      "Both plans add request throttling.\n\nSuggested: build on the gateway limiter and drop the middleware one.",
	})

	for _, want := range []string{
		"Both plans add request throttling",
		"Suggested: build on the gateway limiter",
		"Add a per-user rate limiter in the API gateway",
		"99999999-8888-7777-6666-555555555555",
	} {
		if !strings.Contains(msg, want) {
			t.Errorf("deny message is missing %q:\n%s", want, msg)
		}
	}

	// The counterpart id has to be readable, because `--adopt <theirPlanId>`
	// still asks for it. That command is deliberately unchanged here.
	if !strings.Contains(msg, "--adopt <theirPlanId>") {
		t.Errorf("the resolution menu should be untouched by this change:\n%s", msg)
	}
}

// An older coordinator sends none of the new fields. The message must be
// exactly what it was before, not a half-rendered version with empty labels.
func TestFlaggedDesignReason_WithoutCounterpartFieldsIsUnchanged(t *testing.T) {
	msg := flaggedDesignReason(designScopeMatchResponse{
		DesignID: "11111111-2222-3333-4444-555555555555",
		Verdict:  "llm_divergence",
	})

	if strings.Contains(msg, "Their plan") {
		t.Errorf("no counterpart was sent, so none should be shown:\n%s", msg)
	}
	if !strings.Contains(msg, "Your plan") || !strings.Contains(msg, "on hold until resolved") {
		t.Errorf("the pre-existing details must survive:\n%s", msg)
	}
}

// constraint_violation is one design against a fixed project rule: there is
// no counterpart design, so the server sends no comparator text and the
// admin-gated wording stays.
func TestFlaggedDesignReason_ConstraintViolationKeepsItsOwnWording(t *testing.T) {
	msg := flaggedDesignReason(designScopeMatchResponse{
		DesignID:      "11111111-2222-3333-4444-555555555555",
		Verdict:       "constraint_violation",
		RequiresAdmin: true,
	})

	if strings.Contains(msg, "Their plan") {
		t.Errorf("a constraint violation has no counterpart plan:\n%s", msg)
	}
	if !strings.Contains(msg, "project admin") {
		t.Errorf("the admin-gated note must survive:\n%s", msg)
	}
}

// Printed, not just substring-matched. Two rendering bugs shipped earlier in
// this file's history because every test asserted on substrings and nobody
// looked at the output: a label longer than denyDetailLabelWidth ran into its
// own value, and a value arrived with a prefix already on it.
func TestFlaggedDesignReason_RendersLegibly(t *testing.T) {
	msg := flaggedDesignReason(designScopeMatchResponse{
		DesignID:            "11111111-2222-3333-4444-555555555555",
		Verdict:             "llm_divergence",
		ConflictingDesignID: "99999999-8888-7777-6666-555555555555",
		ConflictSummary:     "Add a per-user rate limiter in the API gateway",
		ConflictReason:      "Both plans add request throttling to the same request path.\n\nSuggested: build on the gateway limiter and drop the middleware one.",
	})
	t.Log("\n" + msg)

	for _, line := range strings.Split(msg, "\n") {
		for _, label := range []string{"Your plan", "Their plan", "Their plan id", "Status"} {
			if !strings.HasPrefix(strings.TrimSpace(line), label) {
				continue
			}
			rest := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), label))
			if rest == "" {
				continue
			}
			if !strings.HasPrefix(line, " ") || !strings.Contains(line, "  ") {
				t.Errorf("label %q looks collided with its value: %q", label, line)
			}
		}
	}
}
