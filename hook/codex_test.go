package main

import (
	"encoding/json"
	"testing"
)

// Codex's editing tool hands the hook a patch, not a file. These cover the
// translation into the one-file-per-call shape the rest of the binary reads,
// and the harness marker that says a transcript path is a Codex rollout
// rather than a Claude transcript.
//
// The payloads below are the real ones, copied from a codex-cli 0.114 session
// driven against a stub model provider with a dumping hook wired into a
// throwaway CODEX_HOME -- including the detail that the patch arrives under
// `command`, not the `input` key the model itself sends.

func TestParseApplyPatch_SingleUpdate(t *testing.T) {
	targets := parseApplyPatch("*** Begin Patch\n" +
		"*** Update File: src/net/retry.ts\n" +
		"@@\n" +
		"-  const delay = 100;\n" +
		"+  const delay = backoff(attempt);\n" +
		"+  const jitter = random(delay);\n" +
		" \n" +
		"*** End Patch\n")

	if len(targets) != 1 {
		t.Fatalf("got %d targets, want 1: %+v", len(targets), targets)
	}
	if targets[0].Path != "src/net/retry.ts" {
		t.Errorf("Path = %q", targets[0].Path)
	}
	// Both added lines, in order, with the markers gone -- this is what
	// claims.ts looks for inside the post-edit file to find the symbol.
	if want := "  const delay = backoff(attempt);\n  const jitter = random(delay);"; targets[0].Added != want {
		t.Errorf("Added = %q, want %q", targets[0].Added, want)
	}
}

func TestParseApplyPatch_MultipleFilesKeepOrderAndDedupe(t *testing.T) {
	targets := parseApplyPatch("*** Begin Patch\n" +
		"*** Add File: docs/codex.md\n" +
		"+# Codex\n" +
		"*** Update File: src/a.ts\n" +
		"+export const a = 1;\n" +
		"*** Update File: src/a.ts\n" +
		"+export const b = 2;\n" +
		"*** Delete File: src/old.ts\n" +
		"*** End Patch\n")

	var paths []string
	for _, target := range targets {
		paths = append(paths, target.Path)
	}
	want := []string{"docs/codex.md", "src/a.ts", "src/old.ts"}
	if len(paths) != len(want) {
		t.Fatalf("paths = %v, want %v", paths, want)
	}
	for i := range want {
		if paths[i] != want[i] {
			t.Fatalf("paths = %v, want %v", paths, want)
		}
	}
	// A file patched twice is one target carrying its first added run: a
	// claim names one edit point, and a second gate check on the same file
	// would ask the coordinator the same question twice.
	if targets[1].Added != "export const a = 1;" {
		t.Errorf("second target Added = %q, want the first hunk's addition", targets[1].Added)
	}
	// A pure deletion has nothing to anchor a symbol lookup on.
	if targets[2].Added != "" {
		t.Errorf("delete target Added = %q, want empty", targets[2].Added)
	}
}

func TestParseApplyPatch_UnifiedDiffHeadersResolve(t *testing.T) {
	targets := parseApplyPatch("--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-old\n+new\n")
	if len(targets) != 1 || targets[0].Path != "src/x.ts" {
		t.Fatalf("targets = %+v, want one src/x.ts", targets)
	}
	if targets[0].Added != "new" {
		t.Errorf("Added = %q, want %q", targets[0].Added, "new")
	}
}

func TestParseApplyPatch_NamesNothing(t *testing.T) {
	// Content with no header at all: the gate's fail-closed branch depends on
	// this returning nothing rather than inventing a target.
	if targets := parseApplyPatch("just some text\n+not a patch\n"); len(targets) != 0 {
		t.Fatalf("targets = %+v, want none", targets)
	}
	if targets := parseApplyPatch(""); len(targets) != 0 {
		t.Fatalf("targets = %+v, want none for an empty patch", targets)
	}
}

func TestCodexPatchText_ReadsCodexsOwnKeyFirst(t *testing.T) {
	// What Codex actually sends.
	if got := codexPatchText(json.RawMessage(`{"command":"*** Begin Patch\n"}`)); got != "*** Begin Patch\n" {
		t.Errorf("command key: got %q", got)
	}
	// What the model sends, in case a future Codex forwards it verbatim.
	if got := codexPatchText(json.RawMessage(`{"input":"patch-from-input"}`)); got != "patch-from-input" {
		t.Errorf("input key: got %q", got)
	}
	if got := codexPatchText(json.RawMessage(`{"unrelated":1}`)); got != "" {
		t.Errorf("unknown shape: got %q, want empty", got)
	}
	if got := codexPatchText(json.RawMessage(`not json`)); got != "" {
		t.Errorf("malformed input: got %q, want empty", got)
	}
}

func TestExpandCodexPatch_ProducesOneCanonicalPayloadPerFile(t *testing.T) {
	payload := hookPayload{
		SessionID:     "01a0c1f5-7088-78b3-9b5c-18523f13a6d8",
		Cwd:           "/home/dev/proj",
		HookEventName: "PreToolUse",
		ToolName:      codexPatchTool,
		ToolInput:     json.RawMessage(`{"command":"*** Begin Patch\n*** Update File: src/a.ts\n+added line\n*** Delete File: src/gone.ts\n*** End Patch\n"}`),
	}

	expanded := expandCodexPatch(payload)
	if len(expanded) != 2 {
		t.Fatalf("got %d payloads, want 2", len(expanded))
	}

	var first struct {
		FilePath  string `json:"file_path"`
		NewString string `json:"new_string"`
	}
	if err := json.Unmarshal(expanded[0].ToolInput, &first); err != nil {
		t.Fatal(err)
	}
	if expanded[0].ToolName != "Edit" {
		t.Errorf("ToolName = %q, want Edit for a patch that adds text", expanded[0].ToolName)
	}
	// Absolute, resolved against the session's cwd: the gate and the daemon
	// each resolve a relative path against a different directory.
	if first.FilePath != "/home/dev/proj/src/a.ts" {
		t.Errorf("file_path = %q, want it resolved against cwd", first.FilePath)
	}
	if first.NewString != "added line" {
		t.Errorf("new_string = %q", first.NewString)
	}
	// Everything else rides along unchanged -- same session, same event.
	if expanded[0].SessionID != payload.SessionID || expanded[0].HookEventName != payload.HookEventName {
		t.Errorf("expanded payload lost its session/event: %+v", expanded[0])
	}

	var second struct {
		FilePath  string `json:"file_path"`
		NewString string `json:"new_string"`
	}
	if err := json.Unmarshal(expanded[1].ToolInput, &second); err != nil {
		t.Fatal(err)
	}
	if expanded[1].ToolName != "Write" {
		t.Errorf("ToolName = %q, want Write for a deletion", expanded[1].ToolName)
	}
	if second.NewString != "" {
		t.Errorf("new_string = %q, want none for a deletion", second.NewString)
	}
}

func TestExpandCodexPatch_AbsolutePathsAreLeftAlone(t *testing.T) {
	payload := hookPayload{
		Cwd:       "/home/dev/proj",
		ToolName:  codexPatchTool,
		ToolInput: json.RawMessage(`{"command":"*** Update File: /elsewhere/b.ts\n+x\n"}`),
	}
	expanded := expandCodexPatch(payload)
	if len(expanded) != 1 {
		t.Fatalf("got %d payloads, want 1", len(expanded))
	}
	var input struct {
		FilePath string `json:"file_path"`
	}
	if err := json.Unmarshal(expanded[0].ToolInput, &input); err != nil {
		t.Fatal(err)
	}
	if input.FilePath != "/elsewhere/b.ts" {
		t.Errorf("file_path = %q, want the absolute path unchanged", input.FilePath)
	}
}

func TestWithHarnessSource_OnlyUnderCodex(t *testing.T) {
	payload := hookPayload{
		HookEventName:  "UserPromptSubmit",
		TranscriptPath: "/home/dev/.codex/sessions/2026/09/20/rollout-2026-09-20T20-14-42-01a0.jsonl",
	}

	// Claude Code: the daemon synthesizes a claude-code-jsonl descriptor from
	// the path itself, and stamping one here would be this binary deciding
	// something (§4).
	t.Setenv("TWING_HARNESS", "")
	if got := withHarnessSource(payload); got.Source != nil {
		t.Errorf("Source = %+v, want none when the harness is unset", got.Source)
	}

	t.Setenv("TWING_HARNESS", "codex")
	got := withHarnessSource(payload)
	if got.Source == nil {
		t.Fatal("Source = nil, want a codex-rollout descriptor")
	}
	if got.Source.Kind != "codex-rollout" {
		t.Errorf("Kind = %q", got.Source.Kind)
	}
	if got.Source.Values["path"] != payload.TranscriptPath {
		t.Errorf("values = %+v, want the transcript path", got.Source.Values)
	}
	// The path is still forwarded too: an older daemon reads that field and
	// nothing else.
	if got.TranscriptPath != payload.TranscriptPath {
		t.Errorf("TranscriptPath = %q, want it left alone", got.TranscriptPath)
	}
}

func TestWithHarnessSource_NeverOverwritesOne(t *testing.T) {
	t.Setenv("TWING_HARNESS", "codex")
	existing := &transcriptSource{Kind: "opencode-sqlite", Values: map[string]string{"sessionId": "s"}}
	got := withHarnessSource(hookPayload{TranscriptPath: "/x.jsonl", Source: existing})
	if got.Source.Kind != "opencode-sqlite" {
		t.Errorf("Kind = %q, want the adapter's own descriptor kept", got.Source.Kind)
	}
}

func TestWithHarnessSource_NoTranscriptPath(t *testing.T) {
	// A Codex event with no transcript (it is nullable in Codex's own schema)
	// must stay sourceless rather than carry a descriptor pointing nowhere.
	t.Setenv("TWING_HARNESS", "codex")
	if got := withHarnessSource(hookPayload{HookEventName: "SessionEnd"}); got.Source != nil {
		t.Errorf("Source = %+v, want none without a path", got.Source)
	}
}

func TestIsDenyVerdict(t *testing.T) {
	if !isDenyVerdict(denyOutput("PreToolUse", "nope")) {
		t.Error("denyOutput should read back as a deny")
	}
	if isDenyVerdict(allowOutput("PreToolUse")) {
		t.Error("allowOutput should not read back as a deny")
	}
	if isDenyVerdict(map[string]any{}) {
		t.Error("an empty map is not a deny")
	}
}

// The session flag the deny messages carry when the harness gives the agent
// no way to resolve its own session id. Codex is that harness today: it
// exports neither variable, so an agent running the command a deny handed it
// would register its design against nothing and be denied again.

func TestSessionScopedCommands_PinnedWhenTheAgentCannotResolveItsSession(t *testing.T) {
	t.Setenv("TWING_SESSION_ID", "")
	t.Setenv("CLAUDE_CODE_SESSION_ID", "")
	setSessionContext("01a0c1f5-7088-78b3-9b5c-18523f13a6d8")
	defer setSessionContext("")

	got := withResolvedSession("run twing design register --from - <<'YAML'")
	want := "run twing design register --session 01a0c1f5-7088-78b3-9b5c-18523f13a6d8 --from - <<'YAML'"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
	// `--id` already names the subject everywhere else.
	if got := withResolvedSession("twing design amend --id abc"); got != "twing design amend --id abc" {
		t.Errorf("amend should be untouched, got %q", got)
	}
}

func TestSessionScopedCommands_LeftAloneWhenTheAgentAlreadyKnows(t *testing.T) {
	// Claude Code and twing's OpenCode adapter both put the session id in the
	// agent's shell, so the flag would be noise in every deny they see.
	t.Setenv("CLAUDE_CODE_SESSION_ID", "s-1")
	setSessionContext("s-1")
	defer setSessionContext("")

	if got := withResolvedSession("twing design register --from -"); got != "twing design register --from -" {
		t.Errorf("got %q, want it unchanged", got)
	}
}
