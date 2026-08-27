package main

import (
	"strings"
	"testing"
)

// handleCacheCheck has had no direct unit coverage before this -- these
// exercise it against fakeDaemon (socket_test.go), the same real-socket
// test double cacheCheck's own tests use, rather than mocking cacheCheck
// itself.

func TestHandleCacheCheck_VersionMismatchOnly_StillEmitsOutput(t *testing.T) {
	fakeDaemon(t, noticesMessage{
		Type:            "notices",
		Items:           nil, // no ordinary notices -- version-only signal
		VersionMismatch: &versionMismatchInfo{ClientVersion: "0.0.1", ServerVersion: "9.9.9"},
	})

	stdout := captureStdout(t, func() {
		handleCacheCheck(hookPayload{SessionID: "sess1", HookEventName: "SessionStart"})
	})

	if stdout == "" {
		t.Fatal("stdout is empty, want the version-mismatch line even with zero ordinary notices")
	}
	if !strings.Contains(stdout, "npm install -g @twing/cli@latest") {
		t.Errorf("stdout = %q, want it to instruct npm install -g @twing/cli@latest", stdout)
	}
	if !strings.Contains(stdout, "twing init") {
		t.Errorf("stdout = %q, want it to instruct twing init -- npm install -g and twing daemon restart alone never refresh the hook binary (found live, 2026-08-27)", stdout)
	}
	if !strings.Contains(stdout, "twing daemon restart") {
		t.Errorf("stdout = %q, want it to instruct twing daemon restart", stdout)
	}
}

func TestHandleCacheCheck_NothingCached_EmptyOutput(t *testing.T) {
	fakeDaemon(t, noticesMessage{Type: "notices"})

	stdout := captureStdout(t, func() {
		handleCacheCheck(hookPayload{SessionID: "sess1", HookEventName: "SessionStart"})
	})

	if stdout != "" {
		t.Errorf("stdout = %q, want empty (clean no-op) when there's nothing cached", stdout)
	}
}

func TestHandleCacheCheck_ItemsAndVersionMismatch_BothJoinedIntoOutput(t *testing.T) {
	fakeDaemon(t, noticesMessage{
		Type:            "notices",
		Items:           []noticeItem{{Message: "some other notice"}},
		VersionMismatch: &versionMismatchInfo{ClientVersion: "0.0.1", ServerVersion: "9.9.9"},
	})

	stdout := captureStdout(t, func() {
		handleCacheCheck(hookPayload{SessionID: "sess1", HookEventName: "SessionStart"})
	})

	if !strings.Contains(stdout, "some other notice") {
		t.Errorf("stdout = %q, want it to include the ordinary notice", stdout)
	}
	if !strings.Contains(stdout, "does not match the coordinator's expected version") {
		t.Errorf("stdout = %q, want it to include the version-mismatch line too", stdout)
	}
}
