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
	pinInstallKind(t, false) // someone installed twing here, so the commands are real
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
	if !strings.Contains(stdout, "npm install -g @twing/cli@9.9.9") {
		t.Errorf("stdout = %q, want it pinned to the coordinator's exact version, not @latest", stdout)
	}
	if strings.Contains(stdout, "@latest") {
		t.Error("must not suggest @latest -- it can be ahead of this specific coordinator")
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
	pinInstallKind(t, false)
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

// The notices path carries the same message as the gate's deny, and needs
// the same split: on a machine nobody installed twing on, the three
// commands are unrunnable, and printing them into every SessionStart is a
// standing invitation for an agent to go try them.
func TestHandleCacheCheck_VersionMismatch_ManagedInstallNamesNoCommand(t *testing.T) {
	pinInstallKind(t, true)
	fakeDaemon(t, noticesMessage{
		Type:            "notices",
		VersionMismatch: &versionMismatchInfo{ClientVersion: "0.0.1", ServerVersion: "9.9.9"},
	})

	stdout := captureStdout(t, func() {
		handleCacheCheck(hookPayload{SessionID: "sess1", HookEventName: "SessionStart"})
	})

	if stdout == "" {
		t.Fatal("stdout is empty -- the mismatch is still worth saying, just not as an instruction")
	}
	for _, forbidden := range []string{"npm install", "twing init", "twing daemon restart"} {
		if strings.Contains(stdout, forbidden) {
			t.Errorf("must not name %q on a machine with no twing on PATH: %s", forbidden, stdout)
		}
	}
	if !strings.Contains(stdout, "updates itself here") {
		t.Errorf("should say twing handles this itself: %s", stdout)
	}
	if !strings.Contains(stdout, "0.0.1") || !strings.Contains(stdout, "9.9.9") {
		t.Errorf("should still name both versions: %s", stdout)
	}
}

// A managed install ahead of the coordinator gets the identical message to
// the behind case above -- self-heal already tried and failed regardless of
// direction, so there is nothing direction-specific left to say. Found by
// code review, 2026-09-10: this function used to check direction first,
// routing a managed+ahead mismatch into the self-installed "please wait for
// the coordinator" text instead.
func TestHandleCacheCheck_VersionMismatch_ManagedAheadMatchesManagedBehind(t *testing.T) {
	pinInstallKind(t, true)
	fakeDaemon(t, noticesMessage{
		Type:            "notices",
		VersionMismatch: &versionMismatchInfo{ClientVersion: "9.9.9", ServerVersion: "0.0.1"},
	})

	stdout := captureStdout(t, func() {
		handleCacheCheck(hookPayload{SessionID: "sess1", HookEventName: "SessionStart"})
	})

	if !strings.Contains(stdout, "updates itself here") {
		t.Errorf("ahead should read exactly like behind on a managed install: %s", stdout)
	}
	if strings.Contains(stdout, "please wait") || strings.Contains(stdout, "Please wait") {
		t.Errorf("must not blame the coordinator on a managed install: %s", stdout)
	}
}

// A self-installed machine that is ahead gets a real, runnable downgrade
// command, pinned to the coordinator's exact version -- not `latest` (npm's
// latest can itself be ahead of this coordinator) and not a generic "wait
// for the coordinator" message, which wrongly blames the server for this
// machine's own over-install.
func TestHandleCacheCheck_VersionMismatch_SelfInstalledAheadOffersDowngrade(t *testing.T) {
	pinInstallKind(t, false)
	fakeDaemon(t, noticesMessage{
		Type:            "notices",
		VersionMismatch: &versionMismatchInfo{ClientVersion: "9.9.9", ServerVersion: "0.0.1"},
	})

	stdout := captureStdout(t, func() {
		handleCacheCheck(hookPayload{SessionID: "sess1", HookEventName: "SessionStart"})
	})

	if !strings.Contains(stdout, "npm install -g @twing/cli@0.0.1") {
		t.Errorf("should offer a downgrade command pinned to the coordinator's exact version: %s", stdout)
	}
	if strings.Contains(stdout, "Coordination server needs an update") {
		t.Errorf("must not blame the coordinator for this machine's own over-install: %s", stdout)
	}
}

// General defensive coverage for the same guard design_gate.go needed for
// real: the daemon's own versionMismatch() only ever stores a ServerVersion
// it successfully parsed from a real /v1/version response, so an
// unparseable value isn't known to reach this exact path today -- but
// nothing stops a future change from doing so, and `@<garbage>` would 404
// off npm just the same, so the same fallback guards it here too.
func TestHandleCacheCheck_VersionMismatch_UnparseableServerVersionFallsBackToLatest(t *testing.T) {
	pinInstallKind(t, false)
	fakeDaemon(t, noticesMessage{
		Type:            "notices",
		VersionMismatch: &versionMismatchInfo{ClientVersion: "0.0.1", ServerVersion: "unknown"},
	})

	stdout := captureStdout(t, func() {
		handleCacheCheck(hookPayload{SessionID: "sess1", HookEventName: "SessionStart"})
	})

	if !strings.Contains(stdout, "npm install -g @twing/cli@latest") {
		t.Errorf("an unparseable server version must fall back to @latest: %s", stdout)
	}
	if strings.Contains(stdout, "@unknown") {
		t.Errorf("must never produce an uninstallable @unknown command: %s", stdout)
	}
}
