package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResolveTwingCommand_UsesShimWhenNotOnPath(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PATH", t.TempDir()) // no twing anywhere
	bin := filepath.Join(home, ".twing", "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "twing"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	got := resolveTwingCommand(`twing design register --summary "<the goal>" --touches <files>`)
	want := filepath.Join(bin, "twing")
	if !strings.HasPrefix(got, want+" design register") {
		t.Errorf("resolveTwingCommand() = %q, want it to start with %q", got, want+" design register")
	}
}

func TestResolveTwingCommand_PrefersBareNameWhenOnPath(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "twing"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)

	got := resolveTwingCommand("twing init")
	if got != "twing init" {
		t.Errorf("resolveTwingCommand() = %q, want the bare name when it resolves", got)
	}
}

func TestResolveTwingCommand_LeavesNonTwingCommandsAlone(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("PATH", t.TempDir())
	got := resolveTwingCommand("npm install -g @twing/cli@latest && twing init && twing daemon restart")
	if got != "npm install -g @twing/cli@latest && twing init && twing daemon restart" {
		t.Errorf("resolveTwingCommand() rewrote a non-twing-prefixed command: %q", got)
	}
}
