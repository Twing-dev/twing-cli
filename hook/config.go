package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Mirrors packages/core/src/config.ts -- ~/.twing/config.json, a map of
// coordinator server URL -> cached auth (multi-server support). Used solely
// by the §17 design-gate path; the capture path (§4) has no config file
// reads beyond the socket path.

// serverAuth mirrors ServerAuth in config.ts.
type serverAuth struct {
	AuthToken string `json:"authToken"`
}

// globalConfig mirrors TwingConfig in config.ts.
type globalConfig struct {
	Servers map[string]serverAuth `json:"servers"`
}

// legacyGlobalConfig is the pre-multi-server on-disk shape: one implicit
// server, keyed by nothing. Mirrors LegacyTwingConfig in config.ts.
type legacyGlobalConfig struct {
	ServerURL string `json:"serverUrl"`
	AuthToken string `json:"authToken"`
}

var serverURLSchemeRe = regexp.MustCompile(`(?i)^[a-z][a-z0-9+.-]*://`)

// normalizeServerURL mirrors config.ts's normalizeServerUrl -- must stay
// consistent with it, same discipline as canonicalizeRemoteURL's documented
// cross-language parity requirement in identity.go, since serverUrl now
// doubles as a map key on both sides of this hook<->CLI boundary. Unlike
// the TS version, this never needs to *throw* on unparseable input --
// callers here always fail open on a bad/missing URL rather than surface an
// error to the agent.
func normalizeServerURL(input string) string {
	withScheme := input
	if !serverURLSchemeRe.MatchString(input) {
		withScheme = "http://" + input
	}
	return strings.TrimSuffix(withScheme, "/")
}

func emptyGlobalConfig() globalConfig {
	return globalConfig{Servers: map[string]serverAuth{}}
}

// readGlobalConfig reads ~/.twing/config.json, transparently migrating the
// old single-slot shape into the new multi-server map on read -- must stay
// consistent with config.ts's readConfig() migration.
func readGlobalConfig() globalConfig {
	home, err := os.UserHomeDir()
	if err != nil {
		return emptyGlobalConfig()
	}
	data, err := os.ReadFile(filepath.Join(home, ".twing", "config.json"))
	if err != nil {
		return emptyGlobalConfig()
	}

	// A "servers" key present (even if empty) means this file is already in
	// the new shape; its absence means the old single-slot shape.
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(data, &probe); err != nil {
		return emptyGlobalConfig()
	}
	if _, hasServers := probe["servers"]; hasServers {
		var cfg globalConfig
		if err := json.Unmarshal(data, &cfg); err != nil {
			return emptyGlobalConfig()
		}
		if cfg.Servers == nil {
			cfg.Servers = map[string]serverAuth{}
		}
		return cfg
	}

	var legacy legacyGlobalConfig
	if err := json.Unmarshal(data, &legacy); err != nil || legacy.ServerURL == "" {
		return emptyGlobalConfig()
	}
	return globalConfig{Servers: map[string]serverAuth{normalizeServerURL(legacy.ServerURL): {AuthToken: legacy.AuthToken}}}
}

// twingConfig is the resolved config for one specific repo: its coordinator
// (from the repo's committed .twing/twing.yml, if any -- see manifest.go)
// plus whatever token this machine has cached for that specific server (if
// any). Every call site in design_gate.go uses this, via
// resolveServerConfig -- never readGlobalConfig directly.
type twingConfig struct {
	ServerURL string
	AuthToken string
}

// resolveServerConfig combines the repo-level coordinator
// (readCoordinatorServerURL, manifest.go) with this machine's cached auth
// for that specific server (readGlobalConfig, above). authToken is never
// read from the repo file -- only serverUrl is; the token stays entirely
// local, same property the TS side keeps.
func resolveServerConfig(cwd string) twingConfig {
	serverURL, ok := readCoordinatorServerURL(cwd)
	if !ok {
		return twingConfig{}
	}
	normalized := normalizeServerURL(serverURL)
	global := readGlobalConfig()
	return twingConfig{ServerURL: normalized, AuthToken: global.Servers[normalized].AuthToken}
}
