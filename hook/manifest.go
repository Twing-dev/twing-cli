package main

import (
	"os"
	"path/filepath"

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
// with how computeProjectID/computeDeveloperID already resolve repo
// context on this side, rather than a hand-rolled directory walk.
func readCoordinatorServerURL(cwd string) (string, bool) {
	repoRoot, ok := gitOutput(cwd, "rev-parse", "--show-toplevel")
	if !ok || repoRoot == "" {
		return "", false
	}
	data, err := os.ReadFile(filepath.Join(repoRoot, ".twing", "twing.yml"))
	if err != nil {
		return "", false
	}
	var parsed twingYAML
	if err := yaml.Unmarshal(data, &parsed); err != nil {
		return "", false
	}
	if parsed.Coordinator.ServerURL == "" {
		return "", false
	}
	return parsed.Coordinator.ServerURL, true
}
