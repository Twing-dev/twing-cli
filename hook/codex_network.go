package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Read the effective turn policy, not config.toml (which may be overridden
// or changed after launch), and not the hook's own network connectivity.
// Hooks can reach the coordinator while agent commands remain sandboxed.
// Bound I/O; an absent, unfamiliar, or too-distant context is unknown, not
// evidence that networking is disabled. Ignore an incomplete trailing line.
func codexNetworkRestricted(transcript string) bool {
	f, err := os.Open(transcript)
	if err != nil {
		return false
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil {
		return false
	}
	const limit int64 = 4 * 1024 * 1024
	start := stat.Size() - limit
	if start < 0 {
		start = 0
	}
	data, err := io.ReadAll(io.NewSectionReader(f, start, stat.Size()-start))
	if err != nil {
		return false
	}
	lines := bytes.Split(data, []byte("\n"))
	first := 0
	if start > 0 {
		first = 1 // possibly a partial first record
	}
	// From the last element, not the one before it: with a trailing newline
	// that element is empty and costs one failed parse, while without one it
	// is the newest complete record -- and a rollout caught mid-write is
	// exactly when the newest turn_context matters most. A genuinely partial
	// record fails to parse and is skipped, which is the same outcome.
	for i := len(lines) - 1; i >= first; i-- {
		var line struct {
			Type    string `json:"type"`
			Payload struct {
				SandboxPolicy struct {
					Type          string          `json:"type"`
					NetworkAccess json.RawMessage `json:"network_access"`
				} `json:"sandbox_policy"`
			} `json:"payload"`
		}
		if json.Unmarshal(lines[i], &line) != nil || line.Type != "turn_context" {
			continue
		}
		policy := line.Payload.SandboxPolicy
		switch policy.Type {
		case "workspace-write", "read-only":
			// Older workspace-write contexts omit the default false field.
			if len(policy.NetworkAccess) == 0 {
				return policy.Type == "workspace-write"
			}
			return bytes.Equal(bytes.TrimSpace(policy.NetworkAccess), []byte("false"))
		case "external-sandbox":
			var access string
			return json.Unmarshal(policy.NetworkAccess, &access) == nil && access == "restricted"
		default:
			return false // latest context wins, even when we cannot interpret it
		}
	}
	return false
}

func codexNetworkNotice(config twingConfig) string {
	repoArg := "'" + strings.ReplaceAll(config.RepoRoot, "'", "'\"'\"'") + "'"
	return fmt.Sprintf("twing: edits are blocked because this Codex session has network access disabled.\n\n"+
		"Twing commands need to reach %s. The machine can be online while Codex's command sandbox is offline.\n\n"+
		"To enable network access for a new session in this repo, run:\n\n"+
		"  codex --cd %s -c sandbox_workspace_write.network_access=true\n\n"+
		"Or, for future sessions in this trusted repo, add or update these settings in %s:\n\n"+
		"  [sandbox_workspace_write]\n  network_access = true\n\n"+
		"Then start a new Codex session from inside the repo. A session started above it will not load its config. "+
		"If an administrator enforces restricted networking, ask them to allow access to the coordinator.\n\n"+
		"Agent: show these steps to the user. Do not change their network settings automatically, attempt design registration yet, or bypass the gate.",
		config.ServerURL, repoArg, filepath.Join(config.RepoRoot, ".codex", "config.toml"))
}
