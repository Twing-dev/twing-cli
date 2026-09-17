package main

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Version recovery: bringing a stale machine current without asking anyone.
//
// The coordinator answers 426 when this binary's stamped version doesn't
// match its own, and the deny used to hand the agent `npm install -g
// @twing/cli@latest && twing init && twing daemon restart`. On a machine
// that was set up by the committed bootstrap hook, all three are wrong at
// once: `npm install -g` needs a writable global prefix (sudo on a
// system-Node box), and `twing` isn't on PATH at all, so nothing in that
// line would run. Observed live -- the agent refused, correctly.
//
// **Why here and not in the daemon.** The daemon has had a self-update
// since 0.2.19 (daemon/sync.ts's maybeSelfUpdate). It did not fire, and
// could not have: it discovers a version mismatch by polling
// `/v1/version` for coordinators it has seen claims for, so a machine
// whose daemon is dead -- or was never sent a claim -- has no way to
// notice. The gate is the component that actually *learns* the mismatch,
// synchronously, from the response in hand; and it is the one component
// every machine is guaranteed to be running, since it is what produced the
// deny. So the repair belongs where the detection already happens. The
// daemon's own path stays as the belt-and-braces case, and is still the
// only one that covers a user-writable global install.
//
// Shaped like auth_recovery.go, deliberately: attempt the repair, and on
// success re-resolve and carry on, so the edit proceeds rather than costing
// a denial plus a chore.

// versionRecoveryTimeout bounds the blocking pre-edit path. An npm install,
// an `init` that fetches a hook binary, and a daemon restart, over a slow
// link. Generous, but far below Claude Code's 600s default for a
// PreToolUse command hook -- which matters more than it looks: a hook that
// exceeds its timeout is cancelled and its output *discarded*, and the tool
// call then continues through the normal permission flow. Overrunning would
// therefore turn this fail-closed gate into an open one.
const versionRecoveryTimeout = 3 * time.Minute

// versionRecoveryCooldown keeps a machine that cannot update (npm
// unreachable, registry down, a version the coordinator wants that was
// never published) from paying that timeout on every single edit. Longer
// than auth recovery's, because the failure it guards is less likely to be
// fixed in the next minute by a human doing something obvious.
const versionRecoveryCooldown = 30 * time.Minute

// noVersionRecoveryEnv stops the re-run in rerunUpdatedHook from starting a
// recovery of its own. The cooldown marker below would already break the
// cycle, but a marker is state that can fail to be written; this cannot.
const noVersionRecoveryEnv = "TWING_HOOK_NO_VERSION_RECOVERY"

func twingHomeDir() (string, bool) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", false
	}
	return filepath.Join(home, ".twing"), true
}

// managedInstall reports whether this machine's twing was installed by the
// committed bootstrap hook -- the case where nobody chose to install
// anything and so nobody should be asked to update anything.
//
// A `twing` on PATH resolving outside `~/.twing` means the developer
// installed it themselves. Their copy is theirs to manage: it may sit in a
// root-owned prefix, and replacing a package someone installed deliberately
// is not a background process's call. They keep the existing message, which
// on that machine names commands that genuinely work.
//
// Mirrors updateTarget() in packages/cli/src/daemon/self-update.ts rather
// than inventing a second rule for the same question.
func managedInstall() (shim string, cliPresent bool) {
	twingHome, ok := twingHomeDir()
	if !ok {
		return "", false
	}
	if p, err := exec.LookPath("twing"); err == nil {
		if resolved, err := filepath.EvalSymlinks(p); err != nil || !strings.HasPrefix(resolved, twingHome) {
			// A `twing` on PATH usually means someone installed it and it is
			// theirs to manage -- unless they ran `twing init --ghuser`, which
			// is an explicit request for twing to manage itself here. Without
			// this the leftover global copy would silently opt the machine out
			// of version recovery, which is the regression --ghuser exists to
			// avoid.
			if !autoManaged() {
				return "", false
			}
		}
	}
	// The shim bakes in an absolute node path and the managed entrypoint
	// (install-hook.ts's ensureCliShim), so it keeps working with no PATH
	// and survives npm replacing the package underneath it.
	shim = filepath.Join(twingHome, "bin", "twing")
	if info, err := os.Stat(shim); err != nil || info.IsDir() {
		return "", false
	}
	return shim, true
}

// isManagedInstall answers "did twing install itself here, or did someone
// install it?" for the deny messages, which branch on it to decide whether
// naming a command is useful or insulting.
//
// A variable rather than a plain call so tests can pin it. Every message
// below reads it, and reading the ambient machine would make those tests
// pass or fail depending on whose box they run on -- a contributor with a
// bootstrapped ~/.twing/bin/twing would see different text than CI.
var isManagedInstall = func() bool {
	_, ok := managedInstall()
	return ok
}

// autoManaged reports whether `twing init --ghuser` declared the managed copy
// under ~/.twing authoritative on this machine, even with a global install
// present. Written by that command when it could not remove the global copy
// (a root-owned prefix needs sudo, which a setup command should not demand).
func autoManaged() bool {
	twingHome, ok := twingHomeDir()
	if !ok {
		return false
	}
	_, err := os.Stat(filepath.Join(twingHome, "auto-managed"))
	return err == nil
}

func versionRecoveryMarkerPath() (string, bool) {
	twingHome, ok := twingHomeDir()
	if !ok {
		return "", false
	}
	return filepath.Join(twingHome, "version-recovery-attempted"), true
}

// recentlyAttemptedVersionRecovery reports whether the cooldown is still in
// force, and stamps the marker when it is not -- stamping before the
// attempt rather than after, so a crash or timeout mid-attempt still
// counts. Failing to read or write the marker means "go ahead": a machine
// that cannot use the cooldown should still get its one recovery.
func recentlyAttemptedVersionRecovery() bool {
	marker, ok := versionRecoveryMarkerPath()
	if !ok {
		return false
	}
	if info, err := os.Stat(marker); err == nil && time.Since(info.ModTime()) < versionRecoveryCooldown {
		return true
	}
	_ = os.MkdirAll(filepath.Dir(marker), 0o755)
	_ = os.WriteFile(marker, []byte(time.Now().UTC().Format(time.RFC3339)+"\n"), 0o644)
	return false
}

// recoverVersionAndRerun brings a managed install up to serverVersion and
// replays this hook event through the binary that replaced this one,
// returning its verdict. A false return means the caller should fall back
// to explaining the problem.
//
// The re-run is the reason this is not simply "update, then retry the
// check": the running process *is* the stale binary, and its version is
// compiled in. Re-checking from here would send the same stale version and
// get the same 426. The whole event is handed to the new binary instead,
// with the payload this process read from stdin, and its stdout becomes
// ours -- so a mismatch that would have cost a denial costs nothing at all.
func recoverVersionAndRerun(serverVersion string) ([]byte, bool) {
	if !attemptVersionRecovery(serverVersion) {
		return nil, false
	}
	return rerunUpdatedHook()
}

// attemptVersionRecovery installs serverVersion over the managed install and
// refreshes everything derived from it. Never blocks past
// versionRecoveryTimeout; a false return simply means the caller should
// explain the problem instead.
func attemptVersionRecovery(serverVersion string) bool {
	if os.Getenv(noVersionRecoveryEnv) != "" {
		return false // we are already the re-run; do not recurse
	}
	// Only ever act on a real published version. "unknown" is the server's
	// sentinel for a client that sent no version header at all, and pinning
	// an install to it would fail; "dev" means this binary came from a
	// contributor's own `go build`, and replacing that with a release is
	// the opposite of what they want.
	if _, ok := versionParts(serverVersion); !ok || version == "dev" {
		return false
	}
	shim, ok := managedInstall()
	if !ok {
		return false
	}
	if recentlyAttemptedVersionRecovery() {
		return false
	}

	twingHome, _ := twingHomeDir()
	lib := filepath.Join(twingHome, "lib")
	logVersionRecovery("coordinator wants " + serverVersion + "; updating the managed install (this machine has " + version + ")")

	// The whole sequence, not a shortcut. Swapping only the hook binary
	// would clear this 426 and leave a stale daemon running, and version
	// skew there is silent data loss rather than an inconvenience: an older
	// daemon does not know newer message types and answers them with no
	// reply at all. `init` refreshes the hook binary (whose stamped version
	// is what the gate actually sends) and the launch marker; the restart is
	// required because `init` only ensures *a* daemon is running and reports
	// "already-running" against a stale one.
	//
	// `init` runs in the repo the gate resolved, not in this process's cwd.
	// It reads the coordinator out of a committed `.twing/twing.yml` found by
	// walking up from where it runs, so from a session standing *above* the
	// repo -- the case machine-wide wiring exists to cover -- it exits 1 with
	// "no coordinator configured", recovery aborts before the hook binary is
	// refreshed, and the gate denies every edit for the length of the
	// cooldown. Found live 2026-09-17, the first 0.2.27 -> 0.2.28 recovery
	// from a `~/Projects` session, minutes after shipping the fix for this
	// same cwd-anchoring mistake everywhere else.
	// Refuse to trade a working install for a broken one.
	//
	// Every other Node check guards a machine that has nothing yet, where
	// failing means staying at nothing. This path is different: it replaces a
	// CLI that currently works with a newer one, then runs `init` using it.
	// If this machine's Node is too old for that newer CLI -- an nvm switch,
	// a system rollback, any downgrade since the original install -- the npm
	// step still "succeeds", `init` then dies on a missing API, and a machine
	// that was gating fine minutes ago is left mid-upgrade with a stale hook
	// binary and a cooldown's worth of denials. Staying on the old version is
	// strictly better: the version mismatch still denies, but it denies with
	// a message about versions, and the install underneath stays intact.
	if !nodeCanRunCLI() {
		logVersionRecovery("not updating: " + nodeVersionString() + " is older than the Node " +
			minNodeVersionString() + " the CLI needs, and replacing a working install with one this " +
			"machine cannot run would be worse than the version mismatch")
		return false
	}

	deadline := time.Now().Add(versionRecoveryTimeout)
	steps := []recoveryStep{
		{argv: []string{"npm", "install", "--prefix", lib, "@twing/cli@" + serverVersion, "--no-fund", "--no-audit", "--loglevel=error"}},
		{argv: []string{shim, "init", "--unattended"}, dir: currentRepoRoot},
		{argv: []string{shim, "daemon", "restart"}},
	}
	for _, step := range steps {
		if !runRecoveryStep(step, deadline) {
			return false
		}
	}

	logVersionRecovery("updated to " + serverVersion)
	return true
}

// recoveryStep is one command plus the directory it must run in. An empty
// dir inherits this process's cwd, which is right for the two steps that
// address everything by absolute path (`npm --prefix`, `daemon restart`) and
// wrong for `init`, which resolves the repo from wherever it starts.
type recoveryStep struct {
	argv []string
	dir  string
}

// runRecoveryStep runs one command against the shared deadline, so the three
// of them together cannot exceed versionRecoveryTimeout no matter how the
// time is distributed between them.
func runRecoveryStep(step recoveryStep, deadline time.Time) bool {
	argv := step.argv
	remaining := time.Until(deadline)
	if remaining <= 0 {
		logVersionRecovery("ran out of time before `" + strings.Join(argv, " ") + "`")
		return false
	}

	cmd := exec.Command(argv[0], argv[1:]...)
	if step.dir != "" {
		cmd.Dir = step.dir
	}
	if logFile, err := openGateLog(); err == nil {
		defer logFile.Close()
		cmd.Stdout = logFile
		cmd.Stderr = logFile
	}
	if err := cmd.Start(); err != nil {
		logVersionRecovery("could not start `" + argv[0] + "`: " + err.Error())
		return false
	}

	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			logVersionRecovery("`" + strings.Join(argv, " ") + "` failed: " + err.Error())
			return false
		}
		return true
	case <-time.After(remaining):
		_ = cmd.Process.Kill()
		logVersionRecovery("`" + strings.Join(argv, " ") + "` timed out")
		return false
	}
}

// rerunUpdatedHook replays this event through the freshly-installed binary
// and returns its stdout verbatim. Uses the payload main() already read, so
// nothing has to be re-read from a stdin that is long since consumed.
func rerunUpdatedHook() ([]byte, bool) {
	twingHome, ok := twingHomeDir()
	if !ok {
		return nil, false
	}
	binary := filepath.Join(twingHome, "bin", "twing-hook")
	if info, err := os.Stat(binary); err != nil || info.IsDir() {
		return nil, false
	}

	cmd := exec.Command(binary)
	cmd.Stdin = bytes.NewReader(rawPayload)
	cmd.Env = append(os.Environ(), noVersionRecoveryEnv+"=1")
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	if logFile, err := openGateLog(); err == nil {
		defer logFile.Close()
		cmd.Stderr = logFile
	}

	done := make(chan error, 1)
	if err := cmd.Start(); err != nil {
		logVersionRecovery("could not re-run the updated hook: " + err.Error())
		return nil, false
	}
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			logVersionRecovery("the updated hook exited non-zero: " + err.Error())
			return nil, false
		}
		logVersionRecovery("re-ran this event on the updated hook; using its verdict")
		return stdout.Bytes(), true
	case <-time.After(recoveryTimeout):
		_ = cmd.Process.Kill()
		logVersionRecovery("the updated hook timed out")
		return nil, false
	}
}

func logVersionRecovery(line string) {
	f, err := openGateLog()
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.WriteString(time.Now().UTC().Format(time.RFC3339) + " twing version-recovery: " + line + "\n")
}

// The oldest Node the installed CLI can run under.
//
// A deliberate cross-language mirror of MIN_NODE_MAJOR/MIN_NODE_MINOR in
// `packages/core/src/repo-setup.ts`, in the same spirit as identity.go
// mirroring identity.ts: this process has no way to read that constant, and
// shelling out to the CLI to ask would need the very install this is about
// to replace. Raising the floor means raising it in both places.
const (
	minNodeMajor = 20
	minNodeMinor = 0
)

func minNodeVersionString() string {
	return strconv.Itoa(minNodeMajor) + "." + strconv.Itoa(minNodeMinor)
}

// nodeVersionString is what `node -v` reports, for messages. "node (not
// found)" when there is no node at all, which is a different problem with the
// same consequence here.
func nodeVersionString() string {
	out, err := exec.Command("node", "-v").Output()
	if err != nil {
		return "node (not found)"
	}
	v := strings.TrimSpace(string(out))
	if v == "" {
		return "node (not found)"
	}
	return "node " + v
}

// nodeCanRunCLI reports whether the node on PATH is new enough for the CLI
// version being installed. Anything unparseable is treated as too old: a node
// whose version cannot be read is not one to bet a working install on.
func nodeCanRunCLI() bool {
	out, err := exec.Command("node", "-v").Output()
	if err != nil {
		return false
	}
	major, minor, ok := parseNodeVersion(strings.TrimSpace(string(out)))
	if !ok {
		return false
	}
	if major != minNodeMajor {
		return major > minNodeMajor
	}
	return minor >= minNodeMinor
}

// parseNodeVersion pulls major and minor out of "v22.23.2". Tolerates a
// missing leading "v" and a prerelease suffix ("v23.0.0-nightly").
func parseNodeVersion(raw string) (int, int, bool) {
	v := strings.TrimPrefix(raw, "v")
	if i := strings.IndexAny(v, "-+"); i >= 0 {
		v = v[:i]
	}
	parts := strings.Split(v, ".")
	if len(parts) < 2 {
		return 0, 0, false
	}
	major, err := strconv.Atoi(parts[0])
	if err != nil {
		return 0, 0, false
	}
	minor, err := strconv.Atoi(parts[1])
	if err != nil {
		return 0, 0, false
	}
	return major, minor, true
}
