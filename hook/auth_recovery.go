package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

// Auth recovery: fixing a missing or rejected credential without asking.
//
// The gate's auth denials used to hand the agent `twing login` / `twing
// init` / `twing join --github` mid-edit. That is the wrong shape: it
// spends tokens on an operational chore, and an instruction to run an
// install/auth command arriving as *denied tool output* is what a
// well-behaved agent is supposed to be suspicious of -- observed refused
// more than once. Anything automatable should not be asked of the agent.
//
// All three cases have the same remedy, and `twing init --unattended`
// already performs it non-interactively: it resolves a GitHub token from
// `gh auth token` and joins this repo's project, which mints a PAT (no
// token), refreshes a rejected one (401), or adds the missing project
// membership (403).
//
// It cannot always work -- `gh` may be absent or logged out -- so this is
// an attempt, never a guarantee, and the existing messages remain the
// fallback.

// recoveryTimeout bounds the blocking pre-edit path. A gh token lookup plus
// one join call is well inside this; a hung network is not allowed to hold
// an Edit open indefinitely.
const recoveryTimeout = 25 * time.Second

// recoveryCooldown keeps a machine that genuinely cannot authenticate (no
// gh, logged out) from paying the timeout on every single Edit. One attempt,
// then quiet for a while -- long enough not to be a tax, short enough that
// running `gh auth login` takes effect promptly.
const recoveryCooldown = 10 * time.Minute

func authRecoveryMarkerPath() (string, bool) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", false
	}
	return filepath.Join(home, ".twing", "auth-recovery-attempted"), true
}

// recentlyAttemptedAuthRecovery reports whether the cooldown is still in
// force, and stamps the marker when it is not -- stamping before the attempt
// rather than after, so a crash or timeout mid-attempt still counts. Failing
// to read or write the marker means "go ahead": a machine that cannot use
// the cooldown should still get its one recovery, not be locked out of it.
func recentlyAttemptedAuthRecovery() bool {
	marker, ok := authRecoveryMarkerPath()
	if !ok {
		return false
	}
	if info, err := os.Stat(marker); err == nil && time.Since(info.ModTime()) < recoveryCooldown {
		return true
	}
	_ = os.MkdirAll(filepath.Dir(marker), 0o755)
	_ = os.WriteFile(marker, []byte(time.Now().UTC().Format(time.RFC3339)+"\n"), 0o644)
	return false
}

// attemptAuthRecovery runs `twing init --unattended` in this repo, and
// reports whether it completed cleanly. Never panics and never blocks past
// recoveryTimeout; a false return simply means the caller should fall back
// to explaining the problem.
func attemptAuthRecovery(repoRoot string) bool {
	cli := twingCLIPath()
	if cli == "twing" {
		// Only meaningful if a real one resolves -- twingCLIPath falls back
		// to the bare name when it found nothing, and running that would
		// just fail with "command not found".
		if _, err := exec.LookPath("twing"); err != nil {
			return false
		}
	}
	if recentlyAttemptedAuthRecovery() {
		return false
	}

	logAuthRecovery("attempting `" + cli + " init --unattended` to recover credentials")
	cmd := exec.Command(cli, "init", "--unattended")
	cmd.Dir = repoRoot
	if logFile, err := openGateLog(); err == nil {
		defer logFile.Close()
		cmd.Stdout = logFile
		cmd.Stderr = logFile
	}

	done := make(chan error, 1)
	if err := cmd.Start(); err != nil {
		logAuthRecovery("could not start recovery: " + err.Error())
		return false
	}
	go func() { done <- cmd.Wait() }()

	select {
	case err := <-done:
		if err != nil {
			logAuthRecovery("recovery did not succeed: " + err.Error())
			return false
		}
		logAuthRecovery("recovery succeeded")
		return true
	case <-time.After(recoveryTimeout):
		_ = cmd.Process.Kill()
		logAuthRecovery("recovery timed out")
		return false
	}
}

func openGateLog() (*os.File, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	return os.OpenFile(filepath.Join(home, ".twing", "design-coordinator.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
}

func logAuthRecovery(line string) {
	f, err := openGateLog()
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.WriteString(time.Now().UTC().Format(time.RFC3339) + " twing auth-recovery: " + line + "\n")
}
