package main

import (
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"path/filepath"
)

// daemonLaunchMarker mirrors packages/cli/src/daemon-service.ts's
// writeDaemonLaunchMarker output -- the one thing this side needs to know
// to start the daemon itself. Written once by `twing init`/whenever
// `ensureDaemonRunning` runs; this hook never invents its own idea of where
// daemon/main.js lives -- especially once twing-hook ships as a binary
// decoupled from the TS package layout, it has no way to rediscover that
// path independently.
type daemonLaunchMarker struct {
	Node   string `json:"node"`
	Script string `json:"script"`
}

func daemonLaunchMarkerPath() (string, bool) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", false
	}
	return filepath.Join(home, ".twing", "daemon-launch.json"), true
}

func readDaemonLaunchMarker() (daemonLaunchMarker, bool) {
	path, ok := daemonLaunchMarkerPath()
	if !ok {
		return daemonLaunchMarker{}, false
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return daemonLaunchMarker{}, false
	}
	var marker daemonLaunchMarker
	if err := json.Unmarshal(data, &marker); err != nil {
		return daemonLaunchMarker{}, false
	}
	if marker.Node == "" || marker.Script == "" {
		return daemonLaunchMarker{}, false
	}
	return marker, true
}

// daemonAlive does a cheap, near-instant liveness dial -- deliberately not
// sharing enqueue's/cacheCheck's dial in socket.go since this one only
// cares about connect-or-not, no frame to write or read.
func daemonAlive() bool {
	path := socketPath()
	if path == "" {
		return false
	}
	conn, err := net.DialTimeout("unix", path, dialAndWriteTimeout)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

// selfHealDaemon spawns the daemon if nothing's listening on the socket --
// the fallback for machines with no persistent OS-level service installed
// (all of Windows, today -- see daemon-service.ts), or where the service
// died independently of a reboot. Fire-and-forget: doesn't wait for the
// daemon to finish booting, so this adds no new blocking budget to
// SessionStart -- exactly as advisory/best-effort as enqueue already is.
// Called only from SessionStart (see main.go's dispatch), not on every
// UserPromptSubmit, to keep this off the higher-frequency path.
//
// This is the one place hook/** carries real decision logic ("is the
// daemon up; if not, start one") rather than being a trivial socket/HTTP
// client -- a deliberate, reviewed exception (design doc §4's constraint),
// not an oversight.
func selfHealDaemon() {
	if daemonAlive() {
		return
	}
	marker, ok := readDaemonLaunchMarker()
	if !ok {
		return // no marker -- e.g. never ran `twing init` with this build; silent no-op, same as every other failure on this path
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return
	}
	logFile, err := os.OpenFile(filepath.Join(home, ".twing", "daemon.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err == nil {
		defer logFile.Close()
	}

	cmd := exec.Command(marker.Node, marker.Script)
	if logFile != nil {
		cmd.Stdout = logFile
		cmd.Stderr = logFile
	}
	detachProcess(cmd)
	_ = cmd.Start() // fire-and-forget -- never wait, never fail the hook over this
}
