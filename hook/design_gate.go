package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// design_gate.go implements design doc §17: the one intentionally-blocking
// path in this system. Unlike the capture path (§4), it talks to `twing
// serve` directly over HTTPS/HTTP, bypassing the daemon entirely -- this
// path needs a synchronous verdict before Claude Code proceeds, and routing
// that through the daemon's socket protocol would mean adding a blocking
// hop where none currently exists. Fail-open, always: any error here must
// resolve to an empty stdout + exit 0, same as the capture path, just for a
// different reason (§17.7, not §4's advisory-only policy).

// Two budgets: the Edit|Write status check is a plain in-memory lookup, so
// it stays tight; the ExitPlanMode check may run server-side extraction (a
// real LLM call over the network, §17.3), which routinely takes longer than
// 15s against a free-tier model -- observed directly while testing this
// against openai/gpt-oss-20b:free. Both are well inside Claude Code's
// default 600s hook timeout either way.
const designGateTimeout = 15 * time.Second
const designExtractionTimeout = 60 * time.Second

func designGateEnabled() bool {
	return os.Getenv("TWING_DESIGN_GATE") != "off"
}

func logDesignGate(format string, args ...any) {
	home, err := os.UserHomeDir()
	if err != nil {
		return
	}
	f, err := os.OpenFile(filepath.Join(home, ".twing", "design-coordinator.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	line := fmt.Sprintf(format, args...)
	fmt.Fprintf(f, "%s %s\n", time.Now().Format(time.RFC3339), line)
}

type designCheckRequest struct {
	ProjectID   string `json:"projectId"`
	DeveloperID string `json:"developerId"`
	SessionID   string `json:"sessionId"`
	RawPlanText string `json:"rawPlanText,omitempty"`
}

type designConflict struct {
	ConflictingDesignID string `json:"conflictingDesignId"`
	OverlapKind         string `json:"overlapKind"`
	OverlapDetail       string `json:"overlapDetail"`
	ConflictingSummary  string `json:"conflictingSummary"`
}

type designConstraintInfo struct {
	Statement string `json:"statement"`
	Type      string `json:"type"`
}

type designCheckResponse struct {
	Verdict    string                `json:"verdict"`
	DesignID   string                `json:"designId"`
	Conflicts  []designConflict      `json:"conflicts,omitempty"`
	Constraint *designConstraintInfo `json:"constraint,omitempty"`
}

type designListResponse struct {
	Items []struct {
		ID string `json:"id"`
	} `json:"items"`
}

// setAuthHeader adds the §17.10 bearer token when non-empty -- a no-op
// against a server with no password configured, since authToken is "" in
// that case (resolveServerConfig never has one to give).
func setAuthHeader(req *http.Request, authToken string) {
	if authToken != "" {
		req.Header.Set("authorization", "Bearer "+authToken)
	}
}

func postJSON(targetURL string, body any, timeout time.Duration, authToken string) (*http.Response, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequest(http.MethodPost, targetURL, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("content-type", "application/json")
	setAuthHeader(req, authToken)
	client := &http.Client{Timeout: timeout}
	return client.Do(req)
}

func getJSON(targetURL string, authToken string) (*http.Response, error) {
	req, err := http.NewRequest(http.MethodGet, targetURL, nil)
	if err != nil {
		return nil, err
	}
	setAuthHeader(req, authToken)
	client := &http.Client{Timeout: designGateTimeout}
	return client.Do(req)
}

func writeJSON(v any) {
	encoded, err := json.Marshal(v)
	if err != nil {
		return
	}
	os.Stdout.Write(encoded)
}

func allowOutput(eventName string) map[string]any {
	return map[string]any{
		"hookSpecificOutput": map[string]any{
			"hookEventName":      eventName,
			"permissionDecision": "allow",
		},
	}
}

func denyOutput(eventName, reason string) map[string]any {
	return map[string]any{
		"hookSpecificOutput": map[string]any{
			"hookEventName":            eventName,
			"permissionDecision":       "deny",
			"permissionDecisionReason": reason,
		},
	}
}

// handlePreToolUse is the §17 entry point. Kill-switch first: TWING_DESIGN_GATE=off
// short-circuits to a plain no-op with zero network calls.
func handlePreToolUse(payload hookPayload) {
	if !designGateEnabled() {
		return
	}
	switch payload.ToolName {
	case "ExitPlanMode":
		handleExitPlanMode(payload)
	case "Edit", "Write":
		handleEditWriteGate(payload)
	}
}

func handleExitPlanMode(payload hookPayload) {
	config := resolveServerConfig(payload.Cwd)
	if config.ServerURL == "" {
		return
	}

	var input struct {
		Plan string `json:"plan"`
	}
	if err := json.Unmarshal(payload.ToolInput, &input); err != nil || input.Plan == "" {
		return
	}

	reqBody := designCheckRequest{
		ProjectID:   computeProjectID(payload.Cwd),
		DeveloperID: computeDeveloperID(payload.Cwd),
		SessionID:   payload.SessionID,
		RawPlanText: input.Plan,
	}

	res, err := postJSON(strings.TrimRight(config.ServerURL, "/")+"/v1/designs/check", reqBody, designExtractionTimeout, config.AuthToken)
	if err != nil {
		logDesignGate("ExitPlanMode check failed (fail open): %v", err)
		return
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		logDesignGate("ExitPlanMode check returned status %d (fail open)", res.StatusCode)
		return
	}

	body, err := io.ReadAll(res.Body)
	if err != nil {
		logDesignGate("ExitPlanMode check: failed reading response body (fail open): %v", err)
		return
	}
	var result designCheckResponse
	if err := json.Unmarshal(body, &result); err != nil {
		logDesignGate("ExitPlanMode check: malformed response (fail open): %v", err)
		return
	}

	switch result.Verdict {
	case "clean":
		writeJSON(allowOutput("PreToolUse"))
	case "overlap":
		writeJSON(denyOutput("PreToolUse", overlapReason(result)))
	case "constraint_flag":
		writeJSON(denyOutput("PreToolUse", constraintReason(result)))
	default:
		logDesignGate("ExitPlanMode check: unknown verdict %q (fail open)", result.Verdict)
	}
}

func overlapReason(result designCheckResponse) string {
	var b strings.Builder
	fmt.Fprintf(&b, "twing design coordinator: this design (id %s) overlaps %d other open design(s).", result.DesignID, len(result.Conflicts))
	for _, c := range result.Conflicts {
		fmt.Fprintf(&b, "\n- [%s] conflicts with design %s: %s. Their summary: %s", c.OverlapKind, c.ConflictingDesignID, c.OverlapDetail, c.ConflictingSummary)
	}
	fmt.Fprintf(&b, "\n\nAdopt the existing design and re-run ExitPlanMode once your plan reflects it, or run "+
		"`twing design resolve --id %s --justify \"<reason>\"` to record a justified divergence -- this queues for "+
		"human review and does not itself unblock you.", result.DesignID)
	return b.String()
}

func constraintReason(result designCheckResponse) string {
	statement, constraintType := "", ""
	if result.Constraint != nil {
		statement = result.Constraint.Statement
		constraintType = result.Constraint.Type
	}
	return fmt.Sprintf(
		"twing design coordinator: this design (id %s) matches an existing %s constraint: %q. Adjust your plan to "+
			"comply and re-run ExitPlanMode, or run `twing design resolve --id %s --justify \"<reason>\"` to record a "+
			"justified divergence -- this queues for human review and does not itself unblock you.",
		result.DesignID, constraintType, statement, result.DesignID,
	)
}

func openDesignsURL(serverURL, projectID, sessionID string) string {
	return fmt.Sprintf("%s/v1/designs?projectId=%s&sessionId=%s&status=open",
		strings.TrimRight(serverURL, "/"), url.QueryEscape(projectID), url.QueryEscape(sessionID))
}

func constraintMatchURL(serverURL, projectID, path string) string {
	return fmt.Sprintf("%s/v1/constraints/match?projectId=%s&path=%s",
		strings.TrimRight(serverURL, "/"), url.QueryEscape(projectID), url.QueryEscape(path))
}

type constraintMatchResponse struct {
	Matched    bool                  `json:"matched"`
	Constraint *designConstraintInfo `json:"constraint,omitempty"`
}

// checkPathConstraint is §17.9's ground-truth backstop: checks the literal
// file being edited against the Constraint Store directly, independent of
// whatever the session's registered design claims to touch. Returns
// (matched, reason). Fails open (matched=false) on any network/parse error,
// same as every other check on this path.
func checkPathConstraint(serverURL, authToken, projectID, filePath string) (bool, string) {
	res, err := getJSON(constraintMatchURL(serverURL, projectID, filePath), authToken)
	if err != nil {
		logDesignGate("constraint match check failed (fail open): %v", err)
		return false, ""
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		logDesignGate("constraint match check returned status %d (fail open)", res.StatusCode)
		return false, ""
	}
	body, err := io.ReadAll(res.Body)
	if err != nil {
		logDesignGate("constraint match check: failed reading response body (fail open): %v", err)
		return false, ""
	}
	var result constraintMatchResponse
	if err := json.Unmarshal(body, &result); err != nil {
		logDesignGate("constraint match check: malformed response (fail open): %v", err)
		return false, ""
	}
	if !result.Matched || result.Constraint == nil {
		return false, ""
	}
	return true, fmt.Sprintf(
		"twing design coordinator: %s is covered by an existing %s rule: %q. This applies regardless of what your "+
			"registered design claims to touch. If this is intentional and reviewed, record it as a justified "+
			"divergence: `twing design resolve --id <your-design-id> --justify \"<reason>\"` (queues for human "+
			"review, does not itself unblock you).",
		filePath, result.Constraint.Type, result.Constraint.Statement,
	)
}

// handleEditWriteGate is the universal fallback (§17/spec §9a): if an agent
// skips plan mode entirely, this is what actually gets a design registered
// before its first write. As of §17.9, it also checks the specific file
// against the Constraint Store directly (ground truth) before falling back
// to the "any open design" check -- a session can't sidestep a
// review_required rule just by registering an unrelated design first.
func handleEditWriteGate(payload hookPayload) {
	config := resolveServerConfig(payload.Cwd)
	if config.ServerURL == "" {
		return
	}

	var input struct {
		FilePath string `json:"file_path"`
	}
	_ = json.Unmarshal(payload.ToolInput, &input)

	projectID := computeProjectID(payload.Cwd)

	if input.FilePath != "" {
		if matched, reason := checkPathConstraint(config.ServerURL, config.AuthToken, projectID, input.FilePath); matched {
			writeJSON(denyOutput("PreToolUse", reason))
			return
		}
	}

	res, err := getJSON(openDesignsURL(config.ServerURL, projectID, payload.SessionID), config.AuthToken)
	if err != nil {
		logDesignGate("Edit|Write gate check failed (fail open): %v", err)
		return
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		logDesignGate("Edit|Write gate check returned status %d (fail open)", res.StatusCode)
		return
	}

	body, err := io.ReadAll(res.Body)
	if err != nil {
		logDesignGate("Edit|Write gate: failed reading response body (fail open): %v", err)
		return
	}
	var result designListResponse
	if err := json.Unmarshal(body, &result); err != nil {
		logDesignGate("Edit|Write gate: malformed response (fail open): %v", err)
		return
	}

	if len(result.Items) > 0 {
		writeJSON(allowOutput("PreToolUse"))
		return
	}

	writeJSON(denyOutput("PreToolUse",
		"twing design coordinator: no design registered for this session yet. Either enter plan mode "+
			"(ExitPlanMode registers one automatically), or run `twing design register --summary \"...\" "+
			"--creates a,b --touches c,d --depends-on e,f` directly, then retry this edit.",
	))
}

// handleSessionEnd best-effort closes any open design for this session --
// §17.6's higher-precision substitute for the spec's deferred git-commit
// close trigger. Silent on any failure; this is opportunistic tidying, not
// load-bearing (the TTL sweep is the backstop).
func handleSessionEnd(payload hookPayload) {
	if !designGateEnabled() {
		return
	}
	config := resolveServerConfig(payload.Cwd)
	if config.ServerURL == "" {
		return
	}

	projectID := computeProjectID(payload.Cwd)
	res, err := getJSON(openDesignsURL(config.ServerURL, projectID, payload.SessionID), config.AuthToken)
	if err != nil {
		return
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return
	}
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return
	}
	var result designListResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return
	}

	client := &http.Client{Timeout: designGateTimeout}
	for _, item := range result.Items {
		req, err := http.NewRequest(http.MethodPatch, fmt.Sprintf("%s/v1/designs/%s/close", strings.TrimRight(config.ServerURL, "/"), item.ID), nil)
		if err != nil {
			continue
		}
		setAuthHeader(req, config.AuthToken)
		if resp, err := client.Do(req); err == nil {
			resp.Body.Close()
		}
	}
}
