package main

import (
	"net"
	"os"
	"path/filepath"
	"time"
)

// Hard rule (design doc §4): socket write timeout budget is 50ms. Missing
// socket, dead daemon, or a write that blows this budget must all resolve
// to a silent no-op — never a hang, never a non-zero exit.
const dialAndWriteTimeout = 50 * time.Millisecond

// Cache-check needs a reply, so it gets a little more budget than the
// fire-and-forget enqueue — still well inside the "sub-few-ms" target from
// §14, since the daemon answers from an already-computed local cache.
const cacheCheckTimeout = 150 * time.Millisecond

func socketPath() string {
	if p := os.Getenv("TWING_SOCK"); p != "" {
		return p
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".twing", "daemon.sock")
}

// enqueue writes one frame to the daemon and returns without waiting for a
// reply beyond the OS write ack, per §4. Any failure is swallowed silently.
func enqueue(sessionID, cwd, toolName string, toolInput []byte) {
	path := socketPath()
	if path == "" {
		return
	}
	conn, err := net.DialTimeout("unix", path, dialAndWriteTimeout)
	if err != nil {
		return
	}
	defer conn.Close()

	frame, err := encodeFrame(newEnqueueMessage(sessionID, cwd, toolName, toolInput))
	if err != nil {
		return
	}
	_ = conn.SetWriteDeadline(time.Now().Add(dialAndWriteTimeout))
	_, _ = conn.Write(frame)
}

// sendSessionEnd tells the daemon a session ended, so it can drain whatever
// the transcript gained since the last prompt. Fire-and-forget on exactly
// enqueue's terms -- same dial/write budget, no reply awaited, every failure
// swallowed. Deliberately not routed through design_gate.go's HTTP client:
// that path is §17's blocking exception and is gated on designGateEnabled(),
// which is the wrong lifecycle for capture.
func sendSessionEnd(sessionID, cwd, transcriptPath string) {
	if transcriptPath == "" {
		return
	}
	path := socketPath()
	if path == "" {
		return
	}
	conn, err := net.DialTimeout("unix", path, dialAndWriteTimeout)
	if err != nil {
		return
	}
	defer conn.Close()

	frame, err := encodeFrame(newSessionEndMessage(sessionID, cwd, transcriptPath))
	if err != nil {
		return
	}
	_ = conn.SetWriteDeadline(time.Now().Add(dialAndWriteTimeout))
	_, _ = conn.Write(frame)
}

// cacheCheckResult is cacheCheck's reply -- notices plus an optional
// version-mismatch signal, independent of each other (see
// packages/cli/src/daemon/sync.ts's Syncer.versionMismatch() doc comment
// for why VersionMismatch can be non-nil even when Items is empty).
type cacheCheckResult struct {
	Items           []noticeItem
	VersionMismatch *versionMismatchInfo
}

// cacheCheck asks the daemon for anything cached for this session. Any
// failure (no socket, daemon down, timeout) returns a zero-value result,
// which the caller treats as "nothing cached" — an empty stdout, exit 0
// no-op.
func cacheCheck(sessionID, cwd, transcriptPath string) cacheCheckResult {
	path := socketPath()
	if path == "" {
		return cacheCheckResult{}
	}
	conn, err := net.DialTimeout("unix", path, dialAndWriteTimeout)
	if err != nil {
		return cacheCheckResult{}
	}
	defer conn.Close()

	deadline := time.Now().Add(cacheCheckTimeout)
	_ = conn.SetDeadline(deadline)

	frame, err := encodeFrame(newGetNoticesMessage(sessionID, cwd, transcriptPath))
	if err != nil {
		return cacheCheckResult{}
	}
	if _, err := conn.Write(frame); err != nil {
		return cacheCheckResult{}
	}

	var resp noticesMessage
	if err := readFrame(conn, &resp); err != nil {
		return cacheCheckResult{}
	}
	return cacheCheckResult{Items: resp.Items, VersionMismatch: resp.VersionMismatch}
}
