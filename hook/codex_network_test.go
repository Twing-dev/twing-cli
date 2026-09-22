package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func networkTranscript(t *testing.T, policy string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "rollout.jsonl")
	if err := os.WriteFile(p, []byte(`{"type":"turn_context","payload":{"sandbox_policy":`+policy+`}}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestRestrictedCodexEditBlocksBeforeDesignCheck(t *testing.T) {
	t.Setenv("TWING_HARNESS", "codex")
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.URL.Path == "/v1/constraints/match" {
			_, _ = w.Write([]byte(`{"matched":false}`))
		} else {
			_, _ = w.Write([]byte(`{"state":"in_scope"}`))
		}
	}))
	defer server.Close()
	repo := newTestRepo(t, server.URL)
	setCachedToken(t, server.URL, "test-token")
	payload := editPayload(repo, "test")
	payload.TranscriptPath = networkTranscript(t, `{"type":"workspace-write","network_access":false}`)
	decision, reason := decisionOf(t, captureStdout(t, func() { handleEditWriteGate(payload) }))
	if decision != "deny" || requests != 0 {
		t.Fatalf("decision = %q; requests = %d", decision, requests)
	}
	for _, want := range []string{"network access disabled", "codex --cd", "network_access = true", "Do not change their network settings", server.URL} {
		if !strings.Contains(reason, want) {
			t.Fatalf("missing %q in %s", want, reason)
		}
	}
	if _, err := os.Stat(filepath.Join(repo, ".codex")); !os.IsNotExist(err) {
		t.Fatal("must not create Codex settings")
	}
	// Networking enabled: the normal design gate resumes.
	payload.TranscriptPath = networkTranscript(t, `{"type":"workspace-write","network_access":true}`)
	decision, _ = decisionOf(t, captureStdout(t, func() { handleEditWriteGate(payload) }))
	if decision != "allow" {
		t.Fatalf("enabled session = %q", decision)
	}
	// Other harnesses ignore Codex's policy.
	t.Setenv("TWING_HARNESS", "opencode")
	payload.TranscriptPath = networkTranscript(t, `{"type":"workspace-write","network_access":false}`)
	decision, _ = decisionOf(t, captureStdout(t, func() { handleEditWriteGate(payload) }))
	if decision != "allow" {
		t.Fatalf("other harness = %q", decision)
	}
}

func TestCodexNetworkBlockUsesTargetRepo(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("TWING_HARNESS", "codex")
	transcript := networkTranscript(t, `{"type":"workspace-write","network_access":false}`)
	unmanaged := newTestRepo(t, "")
	payload := editPayload(unmanaged, "test")
	payload.TranscriptPath = transcript
	if output := captureStdout(t, func() { handleEditWriteGate(payload) }); output != "" {
		t.Fatalf("non-Twing repo blocked: %s", output)
	}
	managed := newTestRepo(t, "https://coordinator.example")
	// No cached auth: the network block must precede auth recovery too.
	payload = hookPayload{Cwd: filepath.Dir(managed), TranscriptPath: transcript}
	if verdict := editWriteVerdict(payload, filepath.Join(managed, "foo5")); verdict == nil {
		t.Fatal("parent-started session must block")
	}
}

func TestCodexNetworkPolicy(t *testing.T) {
	for _, tc := range []struct {
		name, policy string
		restricted   bool
	}{
		{"disabled", `{"type":"workspace-write","network_access":false}`, true},
		{"enabled", `{"type":"workspace-write","network_access":true}`, false},
		{"full access", `{"type":"danger-full-access"}`, false},
		{"unknown", `{}`, false},
		{"wrong shape", `{"type":"workspace-write","network_access":"unknown"}`, false},
		{"null", `{"type":"workspace-write","network_access":null}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := codexNetworkRestricted(networkTranscript(t, tc.policy)); got != tc.restricted {
				t.Fatalf("restricted = %v, want %v", got, tc.restricted)
			}
		})
	}
	if codexNetworkRestricted(filepath.Join(t.TempDir(), "missing")) {
		t.Fatal("missing transcript is unknown")
	}
}

func TestCodexNetworkLatestPolicyWins(t *testing.T) {
	for _, policy := range []string{`{"type":"workspace-write","network_access":true}`, `{"type":"future-policy"}`} {
		file := networkTranscript(t, `{"type":"workspace-write","network_access":false}`)
		f, err := os.OpenFile(file, os.O_APPEND|os.O_WRONLY, 0o600)
		if err != nil {
			t.Fatal(err)
		}
		_, err = f.WriteString(`{"type":"turn_context","payload":{"sandbox_policy":` + policy + `}}` + "\n")
		f.Close()
		if err != nil {
			t.Fatal(err)
		}
		if codexNetworkRestricted(file) {
			t.Fatal("must not use an older restricted policy")
		}
	}
}
