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

// The commands a deny suggests are only runnable where the repo is. A
// session started above the repo -- the case the machine-wide wiring exists
// for -- was handed `twing design resolve --id ...`, which resolves its
// project from its own cwd and so either failed outright or (with --server)
// asked about a project id computed from the wrong directory and got a
// confident empty answer. Found live 2026-09-16.
func TestRepoScope_NamesTheRepoOnlyWhenTheSessionIsOutsideIt(t *testing.T) {
	shim := bootstrapOnlyMachine(t)
	t.Cleanup(func() { repoScopeFlag = "" })

	parent := t.TempDir()
	repo := filepath.Join(parent, "repo")
	if err := os.MkdirAll(filepath.Join(repo, "src"), 0o755); err != nil {
		t.Fatal(err)
	}

	setRepoScope(parent, repo)
	got := withResolvedTwingCLI("twing design resolve --id abc --justify \"<reason>\"")
	want := shim + " -C " + repo + " design resolve"
	if !strings.HasPrefix(got, want) {
		t.Errorf("from outside the repo: withResolvedTwingCLI() = %q, want it to start with %q", got, want)
	}

	for _, cwd := range []string{repo, filepath.Join(repo, "src")} {
		setRepoScope(cwd, repo)
		got := withResolvedTwingCLI("twing design resolve --id abc")
		if strings.Contains(got, "-C ") {
			t.Errorf("from %q (inside the repo): withResolvedTwingCLI() = %q, want no -C", cwd, got)
		}
	}
}

func TestRepoScope_LeavesMachineLevelCommandsAlone(t *testing.T) {
	// `login`/`whoami` resolve a coordinator and a machine-local token, never
	// a project. Naming a repo there would imply a dependence they don't have.
	bootstrapOnlyMachine(t)
	t.Cleanup(func() { repoScopeFlag = "" })

	parent := t.TempDir()
	setRepoScope(parent, filepath.Join(parent, "repo"))

	for _, cmd := range []string{"twing login --token <YOUR-SAVED-PAT>", "twing whoami"} {
		if got := withResolvedTwingCLI(cmd); strings.Contains(got, "-C ") {
			t.Errorf("withResolvedTwingCLI(%q) = %q, want no -C", cmd, got)
		}
	}
}

func TestPathWithin_ComparesResolvedPaths(t *testing.T) {
	// `git rev-parse --show-toplevel` resolves symlinks and a harness-reported
	// cwd does not, so /tmp vs /private/tmp on macOS would otherwise read as
	// two unrelated places and put a spurious -C on every deny.
	repo := t.TempDir()
	resolved, err := filepath.EvalSymlinks(repo)
	if err != nil {
		t.Fatal(err)
	}
	if !pathWithin(repo, resolved) {
		t.Errorf("pathWithin(%q, %q) = false, want true", repo, resolved)
	}
	if pathWithin(t.TempDir(), resolved) {
		t.Error("pathWithin() = true for an unrelated directory, want false")
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
