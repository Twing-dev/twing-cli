// twing-hook is spawned fresh per Claude Code hook event, does one of two
// trivial socket operations against the local daemon, and exits. No
// Tree-sitter, no HTTP, no decision logic — see design doc §4.
package main

import (
	"encoding/json"
	"fmt"
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
	// TranscriptPath is Claude Code's own session transcript JSONL, sent on
	// every event and (until now) silently dropped here. Forwarded verbatim
	// to the daemon, which owns every decision about what in it is worth
	// keeping -- the path only, never the content: transcripts run far past
	// the 10MB frame cap in packages/core/src/framing.ts.
	TranscriptPath string `json:"transcript_path"`
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
		// Capture first, and independently: sendSessionEnd is a
		// fire-and-forget socket write on the same dumb-pipe path as
		// enqueue, while handleSessionEnd below is the design gate's
		// synchronous HTTP path and short-circuits on designGateEnabled().
		// Capture must not inherit that lifecycle.
		sendSessionEnd(payload.SessionID, payload.Cwd, payload.TranscriptPath)
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
	result := cacheCheck(payload.SessionID, payload.Cwd, payload.TranscriptPath)

	messages := make([]string, 0, len(result.Items)+1)
	for _, item := range result.Items {
		messages = append(messages, item.Message)
	}
	if vm := result.VersionMismatch; vm != nil {
		// Same direction-awareness as design_gate.go's hookVersionMismatchReason
		// -- npm install -g only ever helps when this machine is the one
		// behind. cmp>0 (ahead of the coordinator) should be unreachable in
		// practice per the coordinator's own publish-then-deploy discipline,
		// but is still handled rather than left to print a nonsense
		// instruction if it ever isn't.
		if cmp, ok := compareVersions(vm.ClientVersion, vm.ServerVersion); ok && cmp > 0 {
			messages = append(messages, fmt.Sprintf(
				"twing: this machine's twing-cli (%s) is newer than the coordinator (%s). "+
					"Coordination server needs an update. Please wait.",
				vm.ClientVersion, vm.ServerVersion))
		} else {
			messages = append(messages, fmt.Sprintf(
				"twing: this machine's twing-cli (%s) does not match the coordinator's expected version (%s). "+
					"Run `npm install -g @twing/cli@latest && twing init && twing daemon restart`.",
				vm.ClientVersion, vm.ServerVersion))
		}
	}
	if len(messages) == 0 {
		// Nothing cached: empty stdout, exit 0 — a clean no-op (§4).
		return
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
