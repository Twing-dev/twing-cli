package main

// Which sessions have actually reached the design gate in a given project.
//
// The gate's deny hands back a `twing design register --session <id>` command
// carrying a 36-character session id, and that id has to arrive byte-exact or
// the design binds to a session that does not exist. When that happens the
// gate keeps denying -- correctly, since nothing is registered for the real
// session -- and there is no diagnostic available to it: "registered for a
// session that never existed" and "not registered at all" are the same state
// seen from the coordinator.
//
// That loop has been reached twice in one day, by two different agents, in two
// different ways: one transcribed a character wrong (`...c36a71` as
// `...c36e71`), and one parsed the wrong field out of the deny text and
// registered the session id `--session`. Neither is exotic. A long random
// string with no redundancy, required exactly, will be copied wrong
// eventually.
//
// So the gate leaves evidence: one file per (project, session) the moment a
// session's edit is actually evaluated. `twing design register` reads it and
// can tell a real session id from a mistyped one -- see
// `packages/cli/src/session-attempts.ts`, which is the only consumer.
//
// **One file per session, never a list.** Two hooks for two concurrent
// sessions in one repo would otherwise read-modify-write the same file and
// lose an entry -- which would turn this from a guard into a source of false
// rejections, the worst possible outcome for a check whose whole job is to
// tell real from mistyped.

import (
	"os"
	"path/filepath"
	"strings"
	"time"
)

// attemptsDirName sits under ~/.twing/sessions alongside capture's own state.
const attemptsDirName = "attempts"

// attemptRetention is how long a record is worth keeping. Long enough that a
// session paused overnight still registers cleanly, short enough that the
// directory does not accumulate a year of dead ids.
const attemptRetention = 48 * time.Hour

// recordSessionAttempt notes that this session reached the gate for this
// project. Best-effort throughout: the check it feeds is a convenience, and a
// machine that cannot write here must still gate edits normally.
func recordSessionAttempt(projectID, sessionID string) {
	if projectID == "" || sessionID == "" {
		return
	}
	path, ok := sessionAttemptPath(projectID, sessionID)
	if !ok {
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return
	}
	// Truncating write rather than create-if-missing: the file's mtime is
	// what expiry reads, so touching it on every attempt is what keeps a
	// long-running session's record alive.
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return
	}
	_ = file.Close()
	pruneSessionAttempts(filepath.Dir(path))
}

// sessionAttemptPath is the record's location, or ok=false when either id
// cannot be used as a filename.
//
// Both ids are checked rather than sanitized. A projectId is a sha256 hex
// digest and a session id is a uuid in every harness twing supports, so
// anything else here is not a value to coerce into a filename -- it is a
// reason to write nothing at all.
func sessionAttemptPath(projectID, sessionID string) (string, bool) {
	if !isPlainID(projectID) || !isPlainID(sessionID) {
		return "", false
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", false
	}
	return filepath.Join(home, ".twing", "sessions", attemptsDirName, projectID+"."+sessionID), true
}

// isPlainID reports whether an id is safe to use as one path segment.
func isPlainID(id string) bool {
	if id == "" || len(id) > 128 || strings.ContainsAny(id, "/\\.") {
		return false
	}
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
		default:
			return false
		}
	}
	return true
}

// pruneSessionAttempts drops records older than the retention window.
// Opportunistic: it runs on the gate's own path, so it only ever reads one
// directory of empty files and never fails the caller.
func pruneSessionAttempts(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	cutoff := time.Now().Add(-attemptRetention)
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil || info.ModTime().After(cutoff) {
			continue
		}
		_ = os.Remove(filepath.Join(dir, entry.Name()))
	}
}
