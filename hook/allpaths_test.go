package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Sweeps every deny message the gate can produce, on a bootstrap-onboarded
// machine, asserting none of them instructs a bare `twing ...`.
func TestEveryDenyMessage_HasNoUnrunnableTwingCommand(t *testing.T) {
	home, _ := os.MkdirTemp("", "h")
	t.Cleanup(func() { os.RemoveAll(home) })
	t.Setenv("HOME", home)
	t.Setenv("PATH", t.TempDir())
	bin := filepath.Join(home, ".twing", "bin")
	os.MkdirAll(bin, 0o755)
	os.WriteFile(filepath.Join(bin, "twing"), []byte("#!/bin/sh\n"), 0o755)

	const server = "https://coordination-server.twing.dev"
	messages := map[string]string{
		"authRequired":     authRequiredReason(server),
		"authRejected403":  authRejectedReason(403, server),
		"authRejected401":  authRejectedReason(401, server),
		"unreachable":      unreachableReason(errors.New("dial tcp: refused")),
		"coordinatorError": coordinatorErrorReason("bad json"),
		"noDesign":         noDesignReason(),
	}

	// A line is an *instruction* only when "twing" is followed by a real
	// subcommand -- headlines like "twing can't reach the coordinator" are
	// prose about the tool and must be left exactly as written.
	for name, msg := range messages {
		for _, line := range strings.Split(msg, "\n") {
			trimmed := strings.TrimSpace(line)
			for _, sub := range twingSubcommands {
				if strings.HasPrefix(trimmed, "twing "+sub) {
					t.Errorf("%s: bare command not runnable on this machine: %q", name, trimmed)
				}
			}
		}
	}
}
