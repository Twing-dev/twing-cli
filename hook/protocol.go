package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"io"
)

// Wire format shared with packages/core/src/framing.ts: a 4-byte big-endian
// uint32 byte length, followed by that many bytes of UTF-8 JSON.

const lengthPrefixBytes = 4

func encodeFrame(v any) ([]byte, error) {
	body, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	buf := new(bytes.Buffer)
	if err := binary.Write(buf, binary.BigEndian, uint32(len(body))); err != nil {
		return nil, err
	}
	buf.Write(body)
	return buf.Bytes(), nil
}

// readFrame reads exactly one length-prefixed frame from r and unmarshals it into v.
func readFrame(r io.Reader, v any) error {
	header := make([]byte, lengthPrefixBytes)
	if _, err := io.ReadFull(r, header); err != nil {
		return err
	}
	bodyLen := binary.BigEndian.Uint32(header)
	body := make([]byte, bodyLen)
	if _, err := io.ReadFull(r, body); err != nil {
		return err
	}
	return json.Unmarshal(body, v)
}

// enqueueMessage mirrors EnqueueMessage in packages/core/src/protocol.ts.
type enqueueMessage struct {
	Type      string          `json:"type"`
	SessionID string          `json:"sessionId"`
	Cwd       string          `json:"cwd"`
	ToolName  string          `json:"toolName"`
	ToolInput json.RawMessage `json:"toolInput"`
}

func newEnqueueMessage(sessionID, cwd, toolName string, toolInput json.RawMessage) enqueueMessage {
	if toolInput == nil {
		toolInput = json.RawMessage("{}")
	}
	return enqueueMessage{
		Type:      "enqueue",
		SessionID: sessionID,
		Cwd:       cwd,
		ToolName:  toolName,
		ToolInput: toolInput,
	}
}

// transcriptSource mirrors TranscriptSourceDescriptor in
// packages/core/src/protocol.ts: where this session's conversation lives, as
// the harness describes it.
//
// Opaque on this side, deliberately. The hook neither builds one nor reads
// one -- it copies whatever the payload carried straight through to the
// daemon (§4). A property bag rather than a field per harness is what keeps
// that true: adding a harness changes the daemon's registry and never this
// file, so the one binary that runs on every tool call stops being a place
// harness knowledge accumulates.
type transcriptSource struct {
	Kind   string            `json:"kind"`
	Values map[string]string `json:"values"`
}

// getNoticesMessage mirrors GetNoticesMessage in packages/core/src/protocol.ts.
// Cwd and TranscriptPath ride along for session conversation capture: this
// message already fires on every SessionStart/UserPromptSubmit, so capture
// needs no new event and no new decision here -- the daemon reads the
// transcript and decides what to keep.
type getNoticesMessage struct {
	Type           string            `json:"type"`
	SessionID      string            `json:"sessionId"`
	Cwd            string            `json:"cwd,omitempty"`
	TranscriptPath string            `json:"transcriptPath,omitempty"`
	Source         *transcriptSource `json:"source,omitempty"`
}

func newGetNoticesMessage(sessionID, cwd, transcriptPath string, source *transcriptSource) getNoticesMessage {
	return getNoticesMessage{Type: "get_notices", SessionID: sessionID, Cwd: cwd, TranscriptPath: transcriptPath, Source: source}
}

// sessionEndMessage mirrors SessionEndMessage in packages/core/src/protocol.ts.
type sessionEndMessage struct {
	Type           string            `json:"type"`
	SessionID      string            `json:"sessionId"`
	Cwd            string            `json:"cwd"`
	TranscriptPath string            `json:"transcriptPath,omitempty"`
	Source         *transcriptSource `json:"source,omitempty"`
}

func newSessionEndMessage(sessionID, cwd, transcriptPath string, source *transcriptSource) sessionEndMessage {
	return sessionEndMessage{Type: "session_end", SessionID: sessionID, Cwd: cwd, TranscriptPath: transcriptPath, Source: source}
}

// noticesMessage mirrors NoticesMessage in packages/core/src/protocol.ts.
type noticeItem struct {
	Message string `json:"message"`
}

// versionMismatchInfo mirrors VersionMismatchInfo in packages/core/src/protocol.ts.
type versionMismatchInfo struct {
	ClientVersion string `json:"clientVersion"`
	ServerVersion string `json:"serverVersion"`
}

// escalationNotice mirrors EscalationNotice in packages/core/src/types.ts --
// one design-review comment a reviewer escalated to this developer. Carries
// the comment text rather than just ids on purpose: this is rendered into a
// session banner that has to be actionable on sight, and an agent that must
// make a network call to learn what it was told is one that will skip it.
type escalationNotice struct {
	CommentID     string `json:"commentId"`
	DesignID      string `json:"designId"`
	ProjectID     string `json:"projectId"`
	DesignSummary string `json:"designSummary"`
	Comment       string `json:"comment"`
	EscalatedBy   string `json:"escalatedBy,omitempty"`
	EscalatedAt   int64  `json:"escalatedAt"`
	URL           string `json:"url,omitempty"`
}

// designLink mirrors DesignLink in packages/core/src/types.ts -- what an
// agent needs to put a review link in a commit message. See main.go's
// renderDesignLinkReminder for why this is re-delivered rather than stated
// once at SessionStart.
type designLink struct {
	DesignID  string `json:"designId"`
	ProjectID string `json:"projectId"`
	Summary   string `json:"summary"`
	URL       string `json:"url"`
}

type noticesMessage struct {
	Type            string               `json:"type"`
	Items           []noticeItem         `json:"items"`
	VersionMismatch *versionMismatchInfo `json:"versionMismatch,omitempty"`
	// Both optional, and absent from any daemon predating them -- a machine
	// mid-upgrade runs a new hook against an old daemon just as often as the
	// reverse, so neither side may require the other to have them.
	Escalations []escalationNotice `json:"escalations,omitempty"`
	DesignLinks []designLink       `json:"designLinks,omitempty"`
}
