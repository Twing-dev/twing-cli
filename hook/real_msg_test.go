package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Renders the exact deny a real session hit ("Before your first edit...") on
// a bootstrap-onboarded machine, and asserts every twing command in it names
// something runnable there. This is the regression that blocked an agent: the
// gate worked, but told it to run `twing design register`, and no `twing`
// existed on PATH.
//
// Uses a short $HOME rather than t.TempDir(): the real path is
// ~/.twing/bin/twing, and a 90-character test tmpdir would wrap the message
// in ways production never sees.
func TestNoDesignDeny_CommandsAreRunnableOnABootstrapMachine(t *testing.T) {
	home, err := os.MkdirTemp("", "h")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(home) })
	t.Setenv("HOME", home)
	t.Setenv("PATH", t.TempDir()) // no twing on PATH

	bin := filepath.Join(home, ".twing", "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "twing"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	shim := filepath.Join(bin, "twing")

	msg := noDesignReason()
	t.Logf("rendered deny:\n%s", msg)

	// Nothing may instruct a bare `twing ...`: there is none here to run.
	for _, line := range strings.Split(msg, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "twing ") {
			t.Errorf("unrunnable bare command survives: %q", strings.TrimSpace(line))
		}
	}

	// The prominent, copy-pasteable commands are rendered on their own line
	// and must stay intact.
	for _, want := range []string{
		shim + ` design register --summary "<the goal>" --touches <files>`,
		shim + " design list --mine --status open",
	} {
		if !strings.Contains(msg, want) {
			t.Errorf("missing intact command %q in:\n%s", want, msg)
		}
	}

	// The note's embedded command is rewritten too (it may wrap, being prose).
	if !strings.Contains(msg, shim) {
		t.Errorf("note's embedded command was not rewritten:\n%s", msg)
	}
}
