package main

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func withIsolatedHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	return home
}

func writeDaemonLaunchMarkerFile(t *testing.T, home string, marker daemonLaunchMarker) {
	t.Helper()
	dir := filepath.Join(home, ".twing")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(marker)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "daemon-launch.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestReadDaemonLaunchMarker_MissingFile(t *testing.T) {
	withIsolatedHome(t)
	_, ok := readDaemonLaunchMarker()
	if ok {
		t.Error("readDaemonLaunchMarker() ok = true, want false when the marker file doesn't exist")
	}
}

func TestReadDaemonLaunchMarker_ValidFile(t *testing.T) {
	home := withIsolatedHome(t)
	writeDaemonLaunchMarkerFile(t, home, daemonLaunchMarker{Node: "/usr/bin/node", Script: "/repo/dist/daemon/main.js"})

	marker, ok := readDaemonLaunchMarker()
	if !ok {
		t.Fatal("readDaemonLaunchMarker() ok = false, want true")
	}
	if marker.Node != "/usr/bin/node" || marker.Script != "/repo/dist/daemon/main.js" {
		t.Errorf("marker = %+v, want {/usr/bin/node /repo/dist/daemon/main.js}", marker)
	}
}

func TestReadDaemonLaunchMarker_MalformedJSON(t *testing.T) {
	home := withIsolatedHome(t)
	dir := filepath.Join(home, ".twing")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "daemon-launch.json"), []byte("not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, ok := readDaemonLaunchMarker()
	if ok {
		t.Error("readDaemonLaunchMarker() ok = true, want false for malformed JSON")
	}
}

func TestReadDaemonLaunchMarker_MissingFields(t *testing.T) {
	home := withIsolatedHome(t)
	writeDaemonLaunchMarkerFile(t, home, daemonLaunchMarker{Node: "", Script: "/repo/dist/daemon/main.js"})
	if _, ok := readDaemonLaunchMarker(); ok {
		t.Error("readDaemonLaunchMarker() ok = true, want false when node is empty")
	}
	writeDaemonLaunchMarkerFile(t, withIsolatedHome(t), daemonLaunchMarker{Node: "/usr/bin/node", Script: ""})
	if _, ok := readDaemonLaunchMarker(); ok {
		t.Error("readDaemonLaunchMarker() ok = true, want false when script is empty")
	}
}

func TestDaemonAlive_NoSocket(t *testing.T) {
	home := t.TempDir()
	t.Setenv("TWING_SOCK", filepath.Join(home, "no-such.sock"))
	if daemonAlive() {
		t.Error("daemonAlive() = true, want false when nothing is listening")
	}
}

func TestDaemonAlive_RealListener(t *testing.T) {
	// A short, non-test-name-derived dir -- macOS's sun_path limit (108
	// bytes) is easy to exceed once t.TempDir() folds in a long test name.
	shortDir, err := os.MkdirTemp("", "twing-sock-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(shortDir)
	sockPath := filepath.Join(shortDir, "d.sock")
	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	t.Setenv("TWING_SOCK", sockPath)

	if !daemonAlive() {
		t.Error("daemonAlive() = false, want true when a real listener is up")
	}
}

// selfHealDaemon is fire-and-forget (cmd.Start(), never Wait()), so these
// assert on an observable side effect within a short poll window rather
// than a return value -- same shape the daemon's own real spawn has, no
// mocking of exec.Command involved.

func TestSelfHealDaemon_DaemonAlreadyAlive_DoesNotSpawn(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	shortDir, err := os.MkdirTemp("", "twing-sock-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(shortDir)
	sockPath := filepath.Join(shortDir, "d.sock")
	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	t.Setenv("TWING_SOCK", sockPath)

	sentinel := filepath.Join(home, "sentinel")
	writeDaemonLaunchMarkerFile(t, home, daemonLaunchMarker{Node: "/usr/bin/touch", Script: sentinel})

	selfHealDaemon()

	time.Sleep(100 * time.Millisecond)
	if _, err := os.Stat(sentinel); err == nil {
		t.Error("selfHealDaemon() spawned the marker's command even though the daemon was already alive")
	}
}

func TestSelfHealDaemon_NoMarker_SilentNoOp(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("TWING_SOCK", filepath.Join(t.TempDir(), "no-such.sock"))

	// Must not panic or hang with nothing to read.
	selfHealDaemon()
}

func TestSelfHealDaemon_DaemonDown_SpawnsMarkerCommand(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("TWING_SOCK", filepath.Join(t.TempDir(), "no-such.sock"))

	sentinel := filepath.Join(home, "sentinel")
	// /usr/bin/touch <sentinel> -- a real, trivial, fast command standing
	// in for `node <daemon/main.js>`; proves selfHealDaemon actually
	// invokes marker.Node/marker.Script, not the real daemon spawn path
	// itself (that's spawn-daemon.ts's own territory, TS-side).
	writeDaemonLaunchMarkerFile(t, home, daemonLaunchMarker{Node: "/usr/bin/touch", Script: sentinel})

	selfHealDaemon()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(sentinel); err == nil {
			return // observed the spawn
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Error("selfHealDaemon() never spawned the marker's command within 2s")
}
