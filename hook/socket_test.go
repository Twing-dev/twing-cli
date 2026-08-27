package main

import (
	"net"
	"os"
	"path/filepath"
	"testing"
)

// fakeDaemon spins up a real Unix socket listener that accepts exactly one
// connection, reads whatever frame is sent, and replies with respond's
// encoded frame -- a test double for the daemon, same net.Listen("unix", ...)
// pattern daemon_launch_test.go already uses, so cacheCheck/handleCacheCheck
// get exercised against a real socket round trip rather than a mock.
func fakeDaemon(t *testing.T, respond noticesMessage) {
	t.Helper()
	shortDir, err := os.MkdirTemp("", "twing-sock-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(shortDir) })
	sockPath := filepath.Join(shortDir, "d.sock")
	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	t.Setenv("TWING_SOCK", sockPath)

	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()

		var req getNoticesMessage
		if err := readFrame(conn, &req); err != nil {
			return
		}
		frame, err := encodeFrame(respond)
		if err != nil {
			return
		}
		_, _ = conn.Write(frame)
	}()
}

func TestCacheCheck_VersionMismatchPresent_ReturnedAlongsideItems(t *testing.T) {
	fakeDaemon(t, noticesMessage{
		Type:            "notices",
		Items:           []noticeItem{{Message: "some other notice"}},
		VersionMismatch: &versionMismatchInfo{ClientVersion: "0.0.1", ServerVersion: "9.9.9"},
	})

	result := cacheCheck("sess1")
	if len(result.Items) != 1 || result.Items[0].Message != "some other notice" {
		t.Errorf("Items = %+v, want the one notice from the fake daemon", result.Items)
	}
	if result.VersionMismatch == nil {
		t.Fatal("VersionMismatch = nil, want it populated")
	}
	if result.VersionMismatch.ClientVersion != "0.0.1" || result.VersionMismatch.ServerVersion != "9.9.9" {
		t.Errorf("VersionMismatch = %+v, want {0.0.1 9.9.9}", result.VersionMismatch)
	}
}

func TestCacheCheck_NoDaemon_ReturnsZeroValue(t *testing.T) {
	t.Setenv("TWING_SOCK", filepath.Join(t.TempDir(), "no-such.sock"))

	result := cacheCheck("sess1")
	if result.Items != nil || result.VersionMismatch != nil {
		t.Errorf("result = %+v, want the zero value when nothing is listening", result)
	}
}
