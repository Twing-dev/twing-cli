package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// managedHome builds a $HOME that looks like a machine the committed
// bootstrap hook set up: the CLI shim in place, and no `twing` on PATH.
func managedHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PATH", t.TempDir()) // nothing on PATH, least of all twing

	bin := filepath.Join(home, ".twing", "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "twing"), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return home
}

func TestManagedInstall_TrueWhenOnlyTheShimExists(t *testing.T) {
	managedHome(t)
	if _, ok := managedInstall(); !ok {
		t.Error("a bootstrapped machine must be recognised as managed -- it is the whole case this exists for")
	}
}

func TestManagedInstall_FalseWhenTwingIsOnPathElsewhere(t *testing.T) {
	// Someone installed twing themselves. Their copy may sit in a root-owned
	// prefix, and replacing a package installed deliberately is not a
	// background process's call -- they keep the message naming commands
	// that genuinely work on their machine.
	managedHome(t)

	pathDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(pathDir, "twing"), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", pathDir)

	if _, ok := managedInstall(); ok {
		t.Error("a self-installed twing on PATH must not be treated as ours to replace")
	}
}

func TestManagedInstall_FalseWhenNothingIsInstalledAtAll(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("PATH", t.TempDir())
	if _, ok := managedInstall(); ok {
		t.Error("no shim and no twing on PATH is not a managed install")
	}
}

func TestRecentlyAttemptedVersionRecovery_FirstCallProceedsAndStamps(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	if recentlyAttemptedVersionRecovery() {
		t.Fatal("first attempt must be allowed through")
	}
	if _, err := os.Stat(filepath.Join(home, ".twing", "version-recovery-attempted")); err != nil {
		t.Errorf("expected the attempt to be stamped: %v", err)
	}
}

func TestRecentlyAttemptedVersionRecovery_SecondCallIsSuppressed(t *testing.T) {
	// A machine that cannot update -- npm unreachable, or a version the
	// coordinator wants that was never published -- must not pay the
	// multi-minute recovery timeout on every single Edit.
	t.Setenv("HOME", t.TempDir())

	recentlyAttemptedVersionRecovery()
	if !recentlyAttemptedVersionRecovery() {
		t.Error("a second attempt inside the cooldown must be suppressed")
	}
}

func TestRecentlyAttemptedVersionRecovery_AllowsAgainAfterCooldown(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	recentlyAttemptedVersionRecovery()
	marker := filepath.Join(home, ".twing", "version-recovery-attempted")
	stale := time.Now().Add(-versionRecoveryCooldown - time.Minute)
	if err := os.Chtimes(marker, stale, stale); err != nil {
		t.Fatal(err)
	}

	if recentlyAttemptedVersionRecovery() {
		t.Error("once the cooldown has elapsed, another attempt must be allowed")
	}
}

// The guards below all have to fail *before* stamping the cooldown marker.
// Burning the single slot on an attempt that was never made would mean a
// machine fixed a moment later stays stale for the next half hour.

func TestAttemptVersionRecovery_SelfInstalled_DeclinesWithoutStamping(t *testing.T) {
	home := managedHome(t)
	pathDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(pathDir, "twing"), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", pathDir)

	if attemptVersionRecovery("0.2.20") {
		t.Error("must not update a twing someone installed themselves")
	}
	assertNoVersionRecoveryStamp(t, home)
}

func TestAttemptVersionRecovery_UnknownServerVersion_DeclinesWithoutStamping(t *testing.T) {
	// "unknown" is the coordinator's sentinel for a client that sent no
	// version header at all. Pinning an install to it would just fail.
	home := managedHome(t)
	if attemptVersionRecovery("unknown") {
		t.Error("must not try to install a version that isn't one")
	}
	assertNoVersionRecoveryStamp(t, home)
}

func TestAttemptVersionRecovery_DevBuild_DeclinesWithoutStamping(t *testing.T) {
	// A contributor's own `go build` is stamped "dev". Replacing that with a
	// published release is the opposite of what they want.
	home := managedHome(t)
	original := version
	version = "dev"
	t.Cleanup(func() { version = original })

	if attemptVersionRecovery("0.2.20") {
		t.Error("must not overwrite a local dev build with a release")
	}
	assertNoVersionRecoveryStamp(t, home)
}

func TestAttemptVersionRecovery_InsideTheRerun_DeclinesWithoutStamping(t *testing.T) {
	// rerunUpdatedHook sets this on the child. Without it, an update that
	// somehow still mismatched would recurse; the cooldown marker would
	// catch that too, but a marker is state that can fail to be written and
	// this cannot.
	home := managedHome(t)
	original := version
	version = "0.2.19"
	t.Cleanup(func() { version = original })
	t.Setenv(noVersionRecoveryEnv, "1")

	if attemptVersionRecovery("0.2.20") {
		t.Error("the re-run must never start a recovery of its own")
	}
	assertNoVersionRecoveryStamp(t, home)
}

func assertNoVersionRecoveryStamp(t *testing.T, home string) {
	t.Helper()
	if _, err := os.Stat(filepath.Join(home, ".twing", "version-recovery-attempted")); err == nil {
		t.Error("declined before attempting anything -- must not burn the cooldown slot")
	}
}

func TestRerunUpdatedHook_NoBinary_ReturnsFalse(t *testing.T) {
	// Nothing to replay the event through. The caller has to fall back to
	// explaining the problem rather than emitting empty output as a verdict.
	t.Setenv("HOME", t.TempDir())
	if _, ok := rerunUpdatedHook(); ok {
		t.Error("must not claim a verdict when there is no binary to get one from")
	}
}

func TestRerunUpdatedHook_ForwardsThePayloadAndReturnsTheVerdict(t *testing.T) {
	// The point of the re-run: the stale process's version is compiled in,
	// so the event has to be handed to the new binary along with the payload
	// this process already consumed from stdin.
	home := t.TempDir()
	t.Setenv("HOME", home)

	bin := filepath.Join(home, ".twing", "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	// Echoes its stdin back, so the assertion proves the payload arrived.
	if err := os.WriteFile(filepath.Join(bin, "twing-hook"), []byte("#!/bin/sh\ncat\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	original := rawPayload
	rawPayload = []byte(`{"hook_event_name":"PreToolUse","session_id":"sess1"}`)
	t.Cleanup(func() { rawPayload = original })

	out, ok := rerunUpdatedHook()
	if !ok {
		t.Fatal("expected the re-run to succeed")
	}
	if string(out) != string(rawPayload) {
		t.Errorf("the new binary must receive this event's payload verbatim: got %q", out)
	}
}
