package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// Mirrors packages/core/src/config.ts -- ~/.twing/config.json, serverUrl
// field only. Used solely by the §17 design-gate path; the capture path
// (§4) has no config file reads beyond the socket path.

type twingConfig struct {
	ServerURL string `json:"serverUrl"`
}

func readServerURL() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	data, err := os.ReadFile(filepath.Join(home, ".twing", "config.json"))
	if err != nil {
		return ""
	}
	var cfg twingConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return ""
	}
	return cfg.ServerURL
}
