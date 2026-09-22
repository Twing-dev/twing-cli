package main

// Codex (OpenAI's CLI) speaks Claude Code's hook protocol almost exactly --
// same `hook_event_name`/`tool_name`/`tool_input` payload, same
// `hookSpecificOutput.permissionDecision` reply, same `transcript_path` on
// every event (verified against codex-cli 0.114 by wiring a dumping hook into
// a throwaway CODEX_HOME and driving a real session). Two things differ, and
// this file is the whole of what twing does about them:
//
//  1. **Codex edits files through one tool, `apply_patch`, whose input is a
//     patch that can name several files at once.** Everywhere else in twing an
//     edit is one file (`tool_input.file_path`), so a patch is expanded here
//     into one canonical Edit/Write per target before any existing handler
//     sees it. The gate then checks every file the patch touches rather than
//     the first one, and capture records a claim per file.
//
//  2. **Codex names no transcript *kind*.** It hands over a path like Claude
//     Code does, but the file behind it is a Codex rollout JSONL, not a Claude
//     transcript -- a different shape entirely, and one the Claude filter
//     would quietly reduce to nothing. `TWING_HARNESS=codex` (set by the
//     wired command, `packages/cli/src/codex-hooks.ts`) is what turns that
//     path into a `codex-rollout` descriptor the daemon can resolve.
//
// This is decision logic, which `main.go`/`socket.go`/`protocol.go`
// deliberately are not (§4) -- hence a file of its own, called from exactly
// two places, with the dumb pipe left dumb.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// codexPatchTool is the only mutating tool Codex reports to hooks. Its
// `tool_input` is `{"command": "<patch text>"}` -- `command`, not `input`,
// even though the model sends `input`: Codex normalizes the freeform tool
// call into a shell-ish shape before the hook sees it. Both keys are read
// below anyway, since that is a wire detail of a tool still under development
// upstream.
const codexPatchTool = "apply_patch"

// harnessIsCodex reports whether this process was spawned by Codex rather
// than Claude Code. The wired command says so (see `codexHookScript` in
// packages/cli/src/codex-hooks.ts); nothing infers it from the payload,
// because "looks like Codex" is exactly the kind of guess that turns into a
// silent mis-parse the first time a harness changes shape.
func harnessIsCodex() bool {
	return strings.EqualFold(strings.TrimSpace(os.Getenv("TWING_HARNESS")), "codex")
}

// codexTranscriptSource names where a Codex session's conversation lives.
//
// Mirrors what twing's OpenCode adapter sends, and for the same reason: the
// daemon is long-lived and shared across every harness on the machine, so it
// cannot work out for itself which of them produced a given JSONL file. The
// kind string is resolved by `registerTranscriptSource("codex-rollout", ...)`
// in packages/cli/src/daemon/codex-rollout-source.ts.
func codexTranscriptSource(transcriptPath string) *transcriptSource {
	if transcriptPath == "" {
		return nil
	}
	return &transcriptSource{Kind: "codex-rollout", Values: map[string]string{"path": transcriptPath}}
}

// withHarnessSource stamps the transcript descriptor a Codex payload cannot
// carry itself. A payload that already names a source (twing's own OpenCode
// adapter builds one) is returned untouched, as is every Claude Code payload
// on a machine where TWING_HARNESS is unset.
func withHarnessSource(payload hookPayload) hookPayload {
	if payload.Source != nil || !harnessIsCodex() {
		return payload
	}
	payload.Source = codexTranscriptSource(payload.TranscriptPath)
	return payload
}

// codexPatchTarget is one file named by an apply_patch envelope, with the
// text that patch adds to it.
type codexPatchTarget struct {
	// Path exactly as the patch wrote it -- repo-relative in every patch
	// Codex has been observed to emit. Callers resolve it against the
	// payload's cwd rather than trusting it to be absolute.
	Path string
	// Added is the first contiguous run of added lines for this file, with
	// the `+` markers stripped, or "" when the patch only deletes.
	//
	// It exists to buy symbol-level claims. `claims.ts` locates an `Edit`'s
	// `new_string` inside the post-edit file to find which symbol was
	// touched; with nothing to locate, a claim degrades to the bare file
	// path -- the same v0 gap a whole-file `Write` has, and one
	// `findDesignDivergences` then skips entirely. The first added run is
	// enough for that lookup and is what a Claude `Edit` would have carried.
	Added string
}

// parseApplyPatch extracts every file an apply_patch envelope names.
//
// The format is Codex's own (`*** Begin Patch` / `*** Add|Update|Delete
// File:` / `*** Move to:` / `*** End Patch`), with unified-diff `+++ b/path`
// tolerated as well so a patch produced by some other generator still
// resolves. Targets keep the order they appear in and are deduplicated: a
// patch that updates one file in several hunks is one claim and one gate
// check, not three.
func parseApplyPatch(patch string) []codexPatchTarget {
	var targets []codexPatchTarget
	index := map[string]int{}

	current := -1
	collecting := false
	// Whether this is one of Codex's own envelopes (`*** Begin Patch`, `***
	// Update File:` ...) rather than a unified diff. It decides whether a
	// `+++ ` line is a header or content: in a Codex patch an added line
	// beginning `++ ` is written `+++ `, and reading that as a header
	// invented a target the patch never named -- which in a gated repo is a
	// deny naming a file the agent never edited.
	codexEnvelope := false

	for _, raw := range strings.Split(patch, "\n") {
		line := strings.TrimRight(raw, "\r")
		if strings.HasPrefix(line, "***") {
			codexEnvelope = true
		}

		if path, ok := patchFileHeader(line, codexEnvelope); ok {
			if existing, seen := index[path]; seen {
				current = existing
			} else {
				targets = append(targets, codexPatchTarget{Path: path})
				index[path] = len(targets) - 1
				current = len(targets) - 1
			}
			collecting = false
			continue
		}

		if current == -1 {
			continue
		}
		// Envelope and unified-diff furniture: never content, and `---`
		// would otherwise read as a deletion line.
		if strings.HasPrefix(line, "***") || strings.HasPrefix(line, "+++") || strings.HasPrefix(line, "---") {
			collecting = false
			continue
		}
		if strings.HasPrefix(line, "+") {
			if collecting {
				targets[current].Added += "\n" + line[1:]
			} else if targets[current].Added == "" {
				targets[current].Added = line[1:]
				collecting = true
			}
			continue
		}
		collecting = false
	}

	return targets
}

// patchFileHeader returns the path a patch header names, if the line is one.
//
// `codexEnvelope` says a `***` header has already been seen, which makes this
// Codex's format rather than a unified diff -- and in that format `+++ ` is
// never a header, only an added line whose content starts with `++ `.
func patchFileHeader(line string, codexEnvelope bool) (string, bool) {
	for _, prefix := range []string{"*** Add File:", "*** Update File:", "*** Delete File:", "*** Move to:"} {
		if strings.HasPrefix(line, prefix) {
			path := strings.TrimSpace(strings.TrimPrefix(line, prefix))
			return path, path != ""
		}
	}
	if !codexEnvelope && strings.HasPrefix(line, "+++ ") {
		path := strings.TrimSpace(strings.TrimPrefix(line, "+++ "))
		path = strings.TrimPrefix(path, "b/")
		if path == "" || path == "/dev/null" {
			return "", false
		}
		return path, true
	}
	return "", false
}

// codexPatchText pulls the patch out of an apply_patch `tool_input`.
//
// Decoded field by field rather than into a struct of strings, so one field
// arriving in an unexpected shape costs only that field. A struct decode is
// all-or-nothing: the day Codex sends `command` as an argv array -- the
// natural shape for a shell-ish field, on a tool its own docs call
// under development -- every key would be lost with it, the patch would read
// as empty, and `handleCodexPatchGate` would then deny *every* edit in every
// repo with a coordinator. Degrading to "read whichever field is a string"
// turns that from an outage into a missing feature.
func codexPatchText(toolInput json.RawMessage) string {
	if len(toolInput) == 0 {
		return ""
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(toolInput, &fields); err != nil {
		return ""
	}
	// `command` first: that is what Codex actually sends. `input` is what the
	// model sends, in case a future version forwards it verbatim.
	for _, key := range []string{"command", "input", "patch"} {
		var candidate string
		if raw, ok := fields[key]; ok && json.Unmarshal(raw, &candidate) == nil && candidate != "" {
			return candidate
		}
	}
	return ""
}

// expandCodexPatch turns one apply_patch payload into one payload per file it
// touches, each in the shape every other twing handler already reads.
//
// `Edit` rather than `Write` whenever the patch adds text, so `claims.ts` has
// a `new_string` to locate and the claim lands on a symbol instead of a bare
// path; a pure deletion has no such anchor and is reported as the whole-file
// `Write` it effectively is.
//
// Paths are made absolute against the payload's cwd here rather than
// downstream. Both consumers (the gate's `resolveServerConfigForFile`, the
// daemon's `extractClaim`) do resolve a relative path themselves -- but each
// against its own notion of cwd, and for a patch those differ: the file is
// relative to the session's working directory, which is not where either of
// them would start from. Doing it once, at the only point that knows both, is
// what keeps them from disagreeing.
func expandCodexPatch(payload hookPayload) []hookPayload {
	targets := parseApplyPatch(codexPatchText(payload.ToolInput))
	expanded := make([]hookPayload, 0, len(targets))
	for _, target := range targets {
		absolute := target.Path
		if !filepath.IsAbs(absolute) {
			absolute = filepath.Join(payload.Cwd, absolute)
		}

		input := map[string]string{"file_path": absolute}
		toolName := "Write"
		if target.Added != "" {
			toolName = "Edit"
			input["new_string"] = target.Added
		}
		encoded, err := json.Marshal(input)
		if err != nil {
			continue
		}

		next := payload
		next.ToolName = toolName
		next.ToolInput = encoded
		expanded = append(expanded, next)
	}
	return expanded
}
