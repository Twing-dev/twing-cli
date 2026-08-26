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

// getNoticesMessage mirrors GetNoticesMessage in packages/core/src/protocol.ts.
type getNoticesMessage struct {
	Type      string `json:"type"`
	SessionID string `json:"sessionId"`
}

func newGetNoticesMessage(sessionID string) getNoticesMessage {
	return getNoticesMessage{Type: "get_notices", SessionID: sessionID}
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

type noticesMessage struct {
	Type            string               `json:"type"`
	Items           []noticeItem         `json:"items"`
	VersionMismatch *versionMismatchInfo `json:"versionMismatch,omitempty"`
}
