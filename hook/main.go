// twing-hook is spawned fresh per Claude Code hook event, does one of two
// trivial socket operations against the local daemon, and exits. No
// Tree-sitter, no HTTP, no decision logic — see design doc §4.
package main

import (
	"encoding/json"
	"io"
	"os"
	"strings"
)

// hookPayload covers the fields present on every event plus the tool-call
// fields present on PostToolUse, per the hooks reference cited in §4.
type hookPayload struct {
	SessionID     string          `json:"session_id"`
	Cwd           string          `json:"cwd"`
	HookEventName string          `json:"hook_event_name"`
	ToolName      string          `json:"tool_name"`
	ToolInput     json.RawMessage `json:"tool_input"`
}

func main() {
	// Hard rule: always exit 0, no matter what. A panic here would otherwise
	// surface as a non-zero exit and, worse, could look like a block.
	defer func() {
		_ = recover()
	}()

	data, err := io.ReadAll(os.Stdin)
	if err != nil {
		return
	}

	var payload hookPayload
	if err := json.Unmarshal(data, &payload); err != nil {
		return
	}

	switch payload.HookEventName {
	case "PostToolUse":
		handlePostToolUse(payload)
	case "SessionStart":
		// Restart-survival fallback for machines with no persistent OS-level
		// daemon service installed (see daemon-service.ts) or where the
		// service died independently of a reboot -- see daemon_launch.go.
		// Only here, not on every UserPromptSubmit, to keep this off the
		// higher-frequency path.
		selfHealDaemon()
		handleCacheCheck(payload)
	case "UserPromptSubmit":
		handleCacheCheck(payload)
	case "PreToolUse":
		// §17's design gate, a separate code path from the capture handlers
		// above -- see design_gate.go. Never used by capture (§4).
		handlePreToolUse(payload)
	case "SessionEnd":
		// §17.6 close trigger. No-op unless the design gate is registered
		// (handleSessionEnd checks TWING_DESIGN_GATE itself).
		handleSessionEnd(payload)
	default:
		// No-op for anything else.
	}
}

func handlePostToolUse(payload hookPayload) {
	switch payload.ToolName {
	case "Edit", "Write", "Read", "Grep", "Glob":
		enqueue(payload.SessionID, payload.Cwd, payload.ToolName, payload.ToolInput)
	default:
		// No-op: not a capture-worthy tool call.
	}
}

func handleCacheCheck(payload hookPayload) {
	items := cacheCheck(payload.SessionID)
	if len(items) == 0 {
		// Nothing cached: empty stdout, exit 0 — a clean no-op (§4).
		return
	}

	messages := make([]string, len(items))
	for i, item := range items {
		messages[i] = item.Message
	}

	output := map[string]any{
		"hookSpecificOutput": map[string]any{
			"hookEventName":     payload.HookEventName,
			"additionalContext": strings.Join(messages, "\n"),
		},
	}
	encoded, err := json.Marshal(output)
	if err != nil {
		return
	}
	os.Stdout.Write(encoded)
}
