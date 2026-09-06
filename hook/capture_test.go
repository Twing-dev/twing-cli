package main

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Session conversation capture rides on two existing shapes: transcript_path
// on the payload every event already carries, and a fire-and-forget socket
// write modeled on enqueue. These cover both -- that the field survives the
// payload decode at all (it was being silently dropped before), and that the
// new send never blocks the hook past its budget.

func TestHookPayload_TranscriptPathRoundTrips(t *testing.T) {
	// A real Claude Code hook payload's shape, trimmed to the fields the
	// hook reads. transcript_path is present on every event.
	raw := []byte(`{
		"session_id": "4d7d71d2-efc9-4868-acda-4ebb8c869945",
		"cwd": "/Users/dev/proj",
		"hook_event_name": "UserPromptSubmit",
		"transcript_path": "/Users/dev/.claude/projects/-Users-dev-proj/4d7d71d2.jsonl"
	}`)

	var payload hookPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.TranscriptPath != "/Users/dev/.claude/projects/-Users-dev-proj/4d7d71d2.jsonl" {
		t.Errorf("TranscriptPath = %q, want the path from the payload", payload.TranscriptPath)
	}
}

func TestHookPayload_TranscriptPathAbsent_IsEmptyNotAnError(t *testing.T) {
	var payload hookPayload
	if err := json.Unmarshal([]byte(`{"session_id":"s","hook_event_name":"SessionEnd"}`), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.TranscriptPath != "" {
		t.Errorf("TranscriptPath = %q, want empty when the payload omits it", payload.TranscriptPath)
	}
}

// captureDaemon accepts one connection and hands back whatever frame was
// written, so a fire-and-forget send can be asserted on without the sender
// ever awaiting a reply.
func captureDaemon(t *testing.T) chan sessionEndMessage {
	t.Helper()
	shortDir, err := os.MkdirTemp("", "twing-cap-")
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

	received := make(chan sessionEndMessage, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		var msg sessionEndMessage
		if err := readFrame(conn, &msg); err != nil {
			return
		}
		received <- msg
	}()
	return received
}

func TestSendSessionEnd_SendsOneFrameAndReturnsWithoutAReply(t *testing.T) {
	received := captureDaemon(t)

	sendSessionEnd("sess1", "/Users/dev/proj", "/tmp/transcript.jsonl")

	select {
	case msg := <-received:
		if msg.Type != "session_end" {
			t.Errorf("Type = %q, want session_end", msg.Type)
		}
		if msg.SessionID != "sess1" || msg.Cwd != "/Users/dev/proj" || msg.TranscriptPath != "/tmp/transcript.jsonl" {
			t.Errorf("msg = %+v, want the session id, cwd and transcript path forwarded verbatim", msg)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no frame reached the daemon")
	}
}

func TestSendSessionEnd_NoTranscriptPath_SendsNothing(t *testing.T) {
	received := captureDaemon(t)

	sendSessionEnd("sess1", "/Users/dev/proj", "")

	select {
	case msg := <-received:
		t.Fatalf("sent %+v, want nothing sent when there's no transcript to capture", msg)
	case <-time.After(200 * time.Millisecond):
		// Expected: no dial at all.
	}
}

func TestSendSessionEnd_NoDaemon_StaysInsideTheHookBudget(t *testing.T) {
	// The §4 rule the whole capture edge lives under: a missing socket or a
	// dead daemon resolves to a silent no-op, never a hang. dialAndWriteTimeout
	// is 50ms; anything near a second here would be a real regression in a
	// path that runs on every session end.
	t.Setenv("TWING_SOCK", filepath.Join(t.TempDir(), "no-such.sock"))

	start := time.Now()
	sendSessionEnd("sess1", "/Users/dev/proj", "/tmp/transcript.jsonl")
	if elapsed := time.Since(start); elapsed > 500*time.Millisecond {
		t.Errorf("took %s, want well inside the fire-and-forget budget with nothing listening", elapsed)
	}
}

func TestCacheCheck_ForwardsCwdAndTranscriptPath(t *testing.T) {
	shortDir, err := os.MkdirTemp("", "twing-cap-")
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

	received := make(chan getNoticesMessage, 1)
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
		received <- req
		frame, err := encodeFrame(noticesMessage{Type: "notices"})
		if err != nil {
			return
		}
		_, _ = conn.Write(frame)
	}()

	cacheCheck("sess1", "/Users/dev/proj", "/tmp/transcript.jsonl")

	select {
	case req := <-received:
		if req.Cwd != "/Users/dev/proj" || req.TranscriptPath != "/tmp/transcript.jsonl" {
			t.Errorf("req = %+v, want cwd and transcriptPath carried on the existing get_notices message", req)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no frame reached the daemon")
	}
}
