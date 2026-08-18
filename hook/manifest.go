package main

import (
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

// twingYAML declares only the field this hook actually needs --
// yaml.v3 silently ignores keys it doesn't know about, so this doesn't need
// to understand constraints/triggers/require_human_review at all (those are
// evaluated server-side, seeded from the TS side's manifest.ts).
type twingYAML struct {
	Coordinator struct {
		ServerURL string `yaml:"serverUrl"`
	} `yaml:"coordinator"`
}

// readCoordinatorServerURL finds cwd's repo root and reads
// coordinator.serverUrl out of its committed .twing/twing.yml, if any.
// Repo-root resolution is delegated to the git binary (git rev-parse
// --show-toplevel), reusing identity.go's gitOutput helper -- consistent
// with how computeProjectID already resolves repo context on this side,
// rather than a hand-rolled directory walk.
//
// Also returns the resolved repoRoot itself (not just the URL) -- callers
// need it to check whether a specific tool_input.file_path actually falls
// inside this repo before applying repo-scoped gate logic to it (see
// design_gate.go's resolveRepoRelative). Surfacing it here avoids a second git
// shell-out for something already resolved on this exact path.
func readCoordinatorServerURL(cwd string) (serverURL string, repoRoot string, ok bool) {
	repoRoot, ok = gitOutput(cwd, "rev-parse", "--show-toplevel")
	if !ok || repoRoot == "" {
		return "", "", false
	}
	data, err := os.ReadFile(filepath.Join(repoRoot, ".twing", "twing.yml"))
	if err != nil {
		return "", "", false
	}
	var parsed twingYAML
	if err := yaml.Unmarshal(data, &parsed); err != nil {
		return "", "", false
	}
	if parsed.Coordinator.ServerURL == "" {
		return "", "", false
	}
	return parsed.Coordinator.ServerURL, repoRoot, true
}

// childCoordinator is one candidate project found by discoverChildCoordinators.
type childCoordinator struct {
	// DirName is cwd's immediate child directory name (not a full path) --
	// this is what a plan's own extracted paths get matched against, since
	// the plan was written with cwd as its reference frame (e.g.
	// "TwingMail/packages/api/mailbox.ts").
	DirName   string
	ServerURL string
	RepoRoot  string
}

// discoverChildCoordinators is the multi-repo ExitPlanMode fallback (fix,
// 2026-08-18): when cwd itself isn't inside any git repo -- the real case
// this was found from is a shared parent directory of several
// independently onboarded repos, e.g. a backend and its separate UI repo,
// worked on together with cwd set to their parent -- readCoordinatorServerURL(cwd)
// fails outright and the gate previously went silently inert for the whole
// session. This instead treats cwd's immediate child directories as
// candidate projects: any child that is itself a git repo with a committed
// .twing/twing.yml is a candidate. Deliberately one level deep only, not a
// recursive walk -- see design_gate.go's handleExitPlanModeMultiCandidate
// for how candidates get narrowed down to the one(s) an actual plan
// belongs to.
func discoverChildCoordinators(cwd string) []childCoordinator {
	entries, err := os.ReadDir(cwd)
	if err != nil {
		return nil
	}
	var out []childCoordinator
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		childPath := filepath.Join(cwd, entry.Name())
		serverURL, repoRoot, ok := readCoordinatorServerURL(childPath)
		if !ok {
			continue
		}
		out = append(out, childCoordinator{DirName: entry.Name(), ServerURL: serverURL, RepoRoot: repoRoot})
	}
	return out
}
