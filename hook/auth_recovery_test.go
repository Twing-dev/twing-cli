package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRecentlyAttemptedAuthRecovery_FirstCallProceedsAndStamps(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	if recentlyAttemptedAuthRecovery() {
		t.Fatal("first attempt must be allowed through")
	}
	marker := filepath.Join(home, ".twing", "auth-recovery-attempted")
	if _, err := os.Stat(marker); err != nil {
		t.Errorf("expected the attempt to be stamped: %v", err)
	}
}

func TestRecentlyAttemptedAuthRecovery_SecondCallIsSuppressed(t *testing.T) {
	// A machine that genuinely cannot authenticate (no gh, or logged out)
	// must not pay the recovery timeout on every single Edit.
	t.Setenv("HOME", t.TempDir())

	recentlyAttemptedAuthRecovery()
	if !recentlyAttemptedAuthRecovery() {
		t.Error("a second attempt inside the cooldown must be suppressed")
	}
}

func TestRecentlyAttemptedAuthRecovery_AllowsAgainAfterCooldown(t *testing.T) {
	// Long enough not to be a tax, short enough that running `gh auth login`
	// takes effect promptly rather than waiting out a long lockout.
	home := t.TempDir()
	t.Setenv("HOME", home)

	recentlyAttemptedAuthRecovery()
	marker := filepath.Join(home, ".twing", "auth-recovery-attempted")
	stale := time.Now().Add(-recoveryCooldown - time.Minute)
	if err := os.Chtimes(marker, stale, stale); err != nil {
		t.Fatal(err)
	}

	if recentlyAttemptedAuthRecovery() {
		t.Error("once the cooldown has elapsed, another attempt must be allowed")
	}
}

func TestAttemptAuthRecovery_NoCliAvailable_FailsFastWithoutStamping(t *testing.T) {
	// With no twing anywhere there is nothing to run. It must not burn the
	// machine's single cooldown slot on an attempt it never made -- otherwise
	// installing twing a moment later would be ignored for ten minutes.
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PATH", t.TempDir())

	if attemptAuthRecovery(t.TempDir()) {
		t.Error("recovery cannot succeed with no CLI present")
	}
	if _, err := os.Stat(filepath.Join(home, ".twing", "auth-recovery-attempted")); err == nil {
		t.Error("must not consume the cooldown when no attempt was possible")
	}
}
