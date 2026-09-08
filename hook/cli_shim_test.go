package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A $HOME with the bootstrap shim present, and a PATH with no twing on it --
// the shape of a machine onboarded by the committed bootstrap hook, which
// deliberately avoids `npm install -g`.
func bootstrapOnlyMachine(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PATH", t.TempDir())
	bin := filepath.Join(home, ".twing", "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "twing"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(bin, "twing")
}

func TestWithResolvedTwingCLI_RewritesCommandsWhenTwingIsNotOnPath(t *testing.T) {
	shim := bootstrapOnlyMachine(t)

	got := withResolvedTwingCLI(`twing design register --summary "<the goal>" --touches <files>`)
	if !strings.HasPrefix(got, shim+" design register") {
		t.Errorf("withResolvedTwingCLI() = %q, want it to start with %q", got, shim+" design register")
	}
}

func TestWithResolvedTwingCLI_RewritesCommandsEmbeddedInNotes(t *testing.T) {
	// The regression this whole change exists for: the most useful
	// instructions live mid-sentence inside explanatory notes, not in
	// command fields, so a fix that only touched Command left them broken.
	shim := bootstrapOnlyMachine(t)

	note := "link this into it instead of starting a new one: twing design amend --id <id> --group <id>"
	got := withResolvedTwingCLI(note)
	if !strings.Contains(got, shim+" design amend") {
		t.Errorf("withResolvedTwingCLI() = %q, want the embedded command rewritten to %q", got, shim+" design amend")
	}
}

func TestWithResolvedTwingCLI_LeavesProseAlone(t *testing.T) {
	// Matching on the subcommand, not the bare word, is what protects these.
	bootstrapOnlyMachine(t)

	for _, prose := range []string{
		"twing blocks rather than risk letting two people edit the same thing",
		"twing checked your edit against this project's own constraints",
		"twing compared your plan against everything else being worked on right now",
		"Start a session there and twing will know which project you mean.",
	} {
		if got := withResolvedTwingCLI(prose); got != prose {
			t.Errorf("withResolvedTwingCLI(%q) rewrote prose to %q", prose, got)
		}
	}
}

func TestWithResolvedTwingCLI_LeavesGlobalInstallInstructionsAlone(t *testing.T) {
	// The version-mismatch deny tells the reader to npm install -g and then
	// run twing. Pointing that at the shim would run the very stale build
	// they are replacing -- and after the install, bare `twing` is right.
	bootstrapOnlyMachine(t)

	msg := "npm install -g @twing/cli@latest && twing init && twing daemon restart"
	if got := withResolvedTwingCLI(msg); got != msg {
		t.Errorf("withResolvedTwingCLI() = %q, want the global-install instruction untouched", got)
	}
}

func TestWithResolvedTwingCLI_PrefersBareNameWhenOnPath(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "twing"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)

	if got := withResolvedTwingCLI("twing init"); got != "twing init" {
		t.Errorf("withResolvedTwingCLI() = %q, want the bare name when it resolves", got)
	}
}
