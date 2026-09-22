package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// The gate's side of the guard rail: leave a record the CLI can check a
// session id against. See session_attempts.go for the two agents that
// registered designs against sessions that never existed.

func TestRecordSessionAttempt_LeavesOneRecordPerSession(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	project := "a1b2c3"

	recordSessionAttempt(project, "session-one")
	recordSessionAttempt(project, "session-two")
	// Twice for the same session is still one record.
	recordSessionAttempt(project, "session-one")

	entries, err := os.ReadDir(filepath.Join(home, ".twing", "sessions", "attempts"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		var names []string
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("got %v, want one record per session", names)
	}
}

func TestRecordSessionAttempt_ConcurrentSessionsDoNotLoseRecords(t *testing.T) {
	// The reason this is a file per session rather than a list in one file:
	// two hooks for two sessions in one repo would read-modify-write the same
	// file and drop an entry -- turning a guard against typos into a source
	// of false rejections, which is worse than not having it.
	home := t.TempDir()
	t.Setenv("HOME", home)

	done := make(chan struct{})
	for i := 0; i < 8; i++ {
		go func(n int) {
			defer func() { done <- struct{}{} }()
			recordSessionAttempt("proj", string(rune('a'+n))+"-session")
		}(i)
	}
	for i := 0; i < 8; i++ {
		<-done
	}

	entries, err := os.ReadDir(filepath.Join(home, ".twing", "sessions", "attempts"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 8 {
		t.Fatalf("got %d records, want all 8 -- concurrent writers must not lose each other's", len(entries))
	}
}

func TestRecordSessionAttempt_RefusesIdsThatAreNotIds(t *testing.T) {
	// A project id is a sha256 digest and a session id is a uuid in every
	// harness twing supports. Anything with a separator in it is not a value
	// to coerce into a filename.
	home := t.TempDir()
	t.Setenv("HOME", home)

	recordSessionAttempt("proj", "../../escape")
	recordSessionAttempt("../../escape", "session")
	recordSessionAttempt("proj", "")
	recordSessionAttempt("", "session")

	if entries, err := os.ReadDir(filepath.Join(home, ".twing", "sessions", "attempts")); err == nil && len(entries) != 0 {
		t.Fatalf("wrote %d records for unusable ids", len(entries))
	}
	if _, err := os.Stat(filepath.Join(home, ".twing", "escape")); err == nil {
		t.Fatal("a path separator in an id escaped the attempts directory")
	}
}

func TestPruneSessionAttempts_DropsOnlyStaleRecords(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".twing", "sessions", "attempts")

	recordSessionAttempt("proj", "fresh")
	recordSessionAttempt("proj", "stale")
	stale := filepath.Join(dir, "proj.stale")
	old := time.Now().Add(-attemptRetention - time.Hour)
	if err := os.Chtimes(stale, old, old); err != nil {
		t.Fatal(err)
	}

	// Any later attempt prunes as a side effect.
	recordSessionAttempt("proj", "fresh")

	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Error("a record past the retention window should be gone")
	}
	if _, err := os.Stat(filepath.Join(dir, "proj.fresh")); err != nil {
		t.Errorf("a live session's record must survive pruning: %v", err)
	}
}

func TestRecordSessionAttempt_RefreshesALongRunningSession(t *testing.T) {
	// A session paused overnight and resumed must not have its record expire
	// underneath it while it is still working.
	home := t.TempDir()
	t.Setenv("HOME", home)
	record := filepath.Join(home, ".twing", "sessions", "attempts", "proj.long")

	recordSessionAttempt("proj", "long")
	old := time.Now().Add(-attemptRetention + time.Hour)
	if err := os.Chtimes(record, old, old); err != nil {
		t.Fatal(err)
	}

	recordSessionAttempt("proj", "long")

	info, err := os.Stat(record)
	if err != nil {
		t.Fatal(err)
	}
	if time.Since(info.ModTime()) > time.Minute {
		t.Error("an attempt should push the record's expiry out, not leave it to age")
	}
}
