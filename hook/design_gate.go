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
// hop where none currently exists.
//
// Fail-closed, deliberately, against a *configured* coordinator: this
// reverses §17.7's original fail-open recommendation
// (design-conflict-coordinator-spec.md §10). This project doesn't design
// for coordinator outages as an operating condition, and a silent allow on
// an auth/network failure is indistinguishable from someone deliberately
// deleting their own cached token to bypass the gate (confirmed live,
// 2026-08-13 -- see the log entries this reversal was made from). Every
// deny below names exactly which of three failure classes it hit -- no
// cached token, a rejected token, or an unreachable/malformed coordinator
// -- so nobody has to guess why a write was blocked. The one path that
// still resolves to a silent allow is a repo with no coordinator configured
// at all (`coordinator.serverUrl` unset): that's "the gate isn't wired up
// here", not a failure, same category as TWING_DESIGN_GATE=off.

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

// resolveRepoRelative resolves filePath (as given in tool_input -- always
// absolute in practice, but cwd-relative is handled too) to a path
// relative to repoRoot, in the same repo-relative, forward-slash format
// every design's creates/touches and every constraint's scope glob is
// declared in (design-store.ts/manifest.ts never store absolute paths).
//
// Found live (2026-08): before this existed, the gate sent tool_input's
// raw absolute file_path straight to both /v1/constraints/match and
// /v1/designs/scope-match, which compare it byte-for-byte (or via
// minimatch) against repo-relative declarations -- an absolute path can
// never match a relative pattern, so both checks silently never matched
// anything for a real session. This is why require_human_review on
// hook/** and packages/server/** never actually fired during this whole
// dogfooding session despite real edits to files under both.
//
// ok is false when filePath resolves outside repoRoot entirely (handled
// the same as "no coordinator configured" by the caller -- see
// handleEditWriteGate). Symlinks are resolved on the directories only,
// never on filePath itself (which may not exist yet for a new Write) --
// macOS's /tmp -> /private/tmp is the concrete case this guards against
// (cwd, as Claude Code reports it, and repoRoot, from `git rev-parse
// --show-toplevel` which does resolve symlinks, could otherwise disagree
// on the spelling of the same location even for a genuinely in-repo file).
func resolveRepoRelative(cwd, repoRoot, filePath string) (rel string, ok bool) {
	if repoRoot == "" {
		return "", false
	}

	resolvedCwd := cwd
	if r, err := filepath.EvalSymlinks(cwd); err == nil {
		resolvedCwd = r
	}
	resolvedRoot := repoRoot
	if r, err := filepath.EvalSymlinks(repoRoot); err == nil {
		resolvedRoot = r
	}

	abs := filePath
	if !filepath.IsAbs(abs) {
		abs = filepath.Join(resolvedCwd, abs)
	} else if dir, err := filepath.EvalSymlinks(filepath.Dir(abs)); err == nil {
		abs = filepath.Join(dir, filepath.Base(abs))
	}
	abs = filepath.Clean(abs)
	root := filepath.Clean(resolvedRoot)

	r, err := filepath.Rel(root, abs)
	if err != nil {
		return "", false
	}
	if r == "." {
		return "", true // the repo root itself -- not "outside", but no sensible relative path to hand back
	}
	if r == ".." || strings.HasPrefix(r, ".."+string(filepath.Separator)) {
		return "", false
	}
	return filepath.ToSlash(r), true // forward slashes -- declared scopes are never platform-specific
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

// developerId is deliberately not part of this shape (§17.10 hardening) --
// the server resolves it from the authenticated bearer token, not a
// client-supplied field.
//
// The structured fields (Creates/Touches/DependsOn/Summary) mirror
// app.ts's DesignCheckRequestBody -- added 2026-08-18 for
// handleExitPlanModeMultiCandidate, which already has a plan pre-extracted
// (via /v1/designs/extract) and partitioned per candidate repo, so it must
// skip server-side extraction the same way `twing design register` already
// does. RawPlanText and the structured fields are mutually exclusive, same
// as the server route's own contract.
type designCheckRequest struct {
	ProjectID   string   `json:"projectId"`
	SessionID   string   `json:"sessionId"`
	RawPlanText string   `json:"rawPlanText,omitempty"`
	Creates     []string `json:"creates,omitempty"`
	Touches     []string `json:"touches,omitempty"`
	DependsOn   []string `json:"dependsOn,omitempty"`
	Summary     string   `json:"summary,omitempty"`
}

// designExtractResponse mirrors ExtractedDesign (design-extract.ts), the
// response shape of the new project-agnostic POST /v1/designs/extract.
type designExtractResponse struct {
	Creates   []string `json:"creates"`
	Touches   []string `json:"touches"`
	DependsOn []string `json:"dependsOn"`
	Summary   string   `json:"summary"`
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
	// Severity (2026-08-19, design-checks.ts's severity split): "warning" |
	// "error" | "" (empty on a "clean" verdict, where it's moot). Only an
	// "error" verdict denies here -- a "warning" (currently tier 1's
	// exactOverlap only) is display-only, same as "clean" as far as this
	// gate is concerned. See DesignSeverity's doc comment in core/types.ts.
	Severity string `json:"severity,omitempty"`
}

// blocksGate reports whether this response's verdict should deny the tool
// call. "clean" never blocks; a non-clean verdict blocks unless it's been
// explicitly demoted to "warning" severity.
func (r designCheckResponse) blocksGate() bool {
	return r.Verdict != "clean" && r.Severity != "warning"
}

type designListResponse struct {
	Items []struct {
		ID string `json:"id"`
	} `json:"items"`
}

// setAuthHeader adds the §17.10 bearer PAT when non-empty. §17 Phase 4:
// when there's no token (a --no-auth coordinator never issues one), falls
// back to the self-declared X-Twing-Developer-Id header instead -- still a
// no-op if developerID is also empty, in which case every call on this
// path fails closed the same as a network error would (a full-auth
// coordinator with no cached token, the only other way both are empty).
func setAuthHeader(req *http.Request, authToken, developerID string) {
	if authToken != "" {
		req.Header.Set("authorization", "Bearer "+authToken)
		return
	}
	if developerID != "" {
		req.Header.Set("x-twing-developer-id", developerID)
	}
}

func postJSON(targetURL string, body any, timeout time.Duration, authToken, developerID string) (*http.Response, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequest(http.MethodPost, targetURL, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("content-type", "application/json")
	setAuthHeader(req, authToken, developerID)
	client := &http.Client{Timeout: timeout}
	return client.Do(req)
}

func getJSON(targetURL string, authToken, developerID string) (*http.Response, error) {
	req, err := http.NewRequest(http.MethodGet, targetURL, nil)
	if err != nil {
		return nil, err
	}
	setAuthHeader(req, authToken, developerID)
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

// agentInstructionSuffix is appended to every deny reason at the one choke
// point (denyOutput) rather than repeated in each *Reason function above --
// found live, 2026-08-16: a fresh agent handling a "no design registered"
// deny correctly ran the suggested `twing design register` command and
// retried, but its final response to the human said only "Done", with zero
// mention that a tool call had been denied or that it had just created a
// persistent, identity-attributed record with the coordinator on the
// operator's behalf. Fixing that with a per-repo CLAUDE.md instruction was
// considered and rejected: it's friction every user would have to author
// for themselves, and a blanket "surface every tool failure" rule
// over-triggers on failures an agent should just fix silently (a typo'd
// path, a missing directory). This suffix instead travels with the
// message itself, so it reaches every agent that hits the gate regardless
// of what (if anything) that repo's own CLAUDE.md says.
const agentInstructionSuffix = "\n\n(This is twing's design-conflict gate -- a coordination check between " +
	"agents/sessions, not a bug to route around. If you act on this yourself, say so explicitly in your reply " +
	"to the operator: what you did and why, not a silent retry-and-succeed -- this creates a persistent record " +
	"attributed to their identity. See twing-cli's README, \"For agents: handling a design-gate deny\", for the " +
	"full explanation.)"

func denyOutput(eventName, reason string) map[string]any {
	return map[string]any{
		"hookSpecificOutput": map[string]any{
			"hookEventName":            eventName,
			"permissionDecision":       "deny",
			"permissionDecisionReason": reason + agentInstructionSuffix,
		},
	}
}

// The four reason strings below are the only ways a call on this path ends
// without a real verdict from the coordinator -- kept as plain strings
// (rather than baked directly into *Output below) because checkPathConstraint
// needs the reason text alone, not the hookSpecificOutput wrapper, to hand
// back to its caller.

func authRequiredReason(serverURL string) string {
	return fmt.Sprintf(
		"twing design coordinator: no auth token cached for %s. Run `twing login --server %s` "+
			"(or `twing init`), then retry -- the design gate blocks rather than letting an "+
			"unauthenticated write through.", serverURL, serverURL)
}

func authRejectedReason() string {
	return "twing design coordinator: authentication rejected (401/403). Your cached token is " +
		"stale or revoked -- run `twing login` to get a valid one, then retry."
}

func unreachableReason(err error) string {
	return fmt.Sprintf(
		"twing design coordinator unreachable: %v. This action is blocked until the coordinator "+
			"is reachable -- the design gate does not fail open. Set TWING_DESIGN_GATE=off if you "+
			"need to work offline.", err)
}

func coordinatorErrorReason(detail string) string {
	return fmt.Sprintf(
		"twing design coordinator error: %s. This action is blocked -- the design gate does not "+
			"fail open. Set TWING_DESIGN_GATE=off if you need to work offline.", detail)
}

func authRequiredOutput(eventName, serverURL string) map[string]any {
	return denyOutput(eventName, authRequiredReason(serverURL))
}

func authRejectedOutput(eventName string) map[string]any {
	return denyOutput(eventName, authRejectedReason())
}

func unreachableOutput(eventName string, err error) map[string]any {
	return denyOutput(eventName, unreachableReason(err))
}

func coordinatorErrorOutput(eventName, detail string) map[string]any {
	return denyOutput(eventName, coordinatorErrorReason(detail))
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

// handleExitPlanMode dispatches on whether cwd resolves to a single repo
// (the common case, unchanged logic) or not. The multi-candidate fallback
// (fix, 2026-08-18) is for cwd being a shared parent of several
// independently onboarded repos -- see discoverChildCoordinators's doc
// comment (manifest.go).
func handleExitPlanMode(payload hookPayload) {
	if config := resolveServerConfig(payload.Cwd); config.ServerURL != "" {
		handleExitPlanModeSingle(payload, config)
		return
	}
	handleExitPlanModeMultiCandidate(payload)
}

func handleExitPlanModeSingle(payload hookPayload, config twingConfig) {
	var input struct {
		Plan string `json:"plan"`
	}
	if err := json.Unmarshal(payload.ToolInput, &input); err != nil || input.Plan == "" {
		return
	}

	projectID := computeProjectID(config.RepoRoot)

	if isGateDisabled(projectID) {
		return
	}

	if config.AuthToken == "" && !config.NoAuth {
		writeJSON(authRequiredOutput("PreToolUse", config.ServerURL))
		return
	}
	developerID := ""
	if config.NoAuth {
		developerID = computeDeveloperID(config.RepoRoot)
	}

	reqBody := designCheckRequest{
		ProjectID:   projectID,
		SessionID:   payload.SessionID,
		RawPlanText: input.Plan,
	}

	result, failReason := postDesignCheck(config.ServerURL, config.AuthToken, developerID, reqBody)
	if failReason != "" {
		writeJSON(denyOutput("PreToolUse", failReason))
		return
	}

	switch {
	case result.Verdict == "clean":
		writeJSON(allowOutput("PreToolUse"))
	case !result.blocksGate():
		// 2026-08-19, severity split: an "overlap" verdict demoted to
		// "warning" (tier 1's exactOverlap only, currently) registers and
		// allows same as clean -- the conflict is still recorded server-side
		// for display, just not gate-relevant. Only "overlap"/"error" and
		// "constraint_flag" (always "error") reach the deny branch below.
		writeJSON(allowOutput("PreToolUse"))
	case result.Verdict == "overlap":
		writeJSON(denyOutput("PreToolUse", overlapReason(result)))
	case result.Verdict == "constraint_flag":
		writeJSON(denyOutput("PreToolUse", constraintReason(result)))
	default:
		logDesignGate("ExitPlanMode check: unknown verdict %q (blocking)", result.Verdict)
		writeJSON(coordinatorErrorOutput("PreToolUse", fmt.Sprintf("unknown verdict %q", result.Verdict)))
	}
}

// handleExitPlanModeMultiCandidate is the fallback when cwd itself isn't
// inside any git repo (fix, 2026-08-18). Extracts the plan once per
// distinct coordinator among the candidates found -- not once per
// candidate, since extraction is a real Bedrock call (§17.3) and every
// candidate sharing one coordinator (the common case: several repos owned
// by the same team, one shared coordinator) would otherwise register
// subtly different extractions of the same plan -- then partitions the
// extracted creates/touches by which candidate's directory name prefixes
// each path (the plan was written with cwd as its reference frame, so a
// path belonging to a specific child repo naturally appears prefixed with
// that repo's directory name), registering via /v1/designs/check's
// structured, pre-extracted path only in the candidate(s) that actually
// match. A plan matching two candidates registers in both.
func handleExitPlanModeMultiCandidate(payload hookPayload) {
	candidates := discoverChildCoordinators(payload.Cwd)
	if len(candidates) == 0 {
		// Genuinely nothing configured anywhere reachable from cwd -- same
		// "not wired up here" allow as the single-repo case.
		return
	}

	var input struct {
		Plan string `json:"plan"`
	}
	if err := json.Unmarshal(payload.ToolInput, &input); err != nil || input.Plan == "" {
		return
	}

	type group struct {
		config     twingConfig
		candidates []childCoordinator
	}
	groups := map[string]*group{}
	var order []string
	for _, cand := range candidates {
		cfg := resolveConfigForCandidate(cand)
		g, ok := groups[cfg.ServerURL]
		if !ok {
			g = &group{config: cfg}
			groups[cfg.ServerURL] = g
			order = append(order, cfg.ServerURL)
		}
		g.candidates = append(g.candidates, cand)
	}

	var denyReasons []string
	matchedAny := false

	for _, key := range order {
		g := groups[key]
		cfg := g.config

		if cfg.AuthToken == "" && !cfg.NoAuth {
			writeJSON(authRequiredOutput("PreToolUse", cfg.ServerURL))
			return
		}
		developerID := ""
		if cfg.NoAuth {
			developerID = computeDeveloperID(g.candidates[0].RepoRoot)
		}

		extracted, failReason := postDesignExtract(cfg.ServerURL, cfg.AuthToken, developerID, input.Plan)
		if failReason != "" {
			writeJSON(denyOutput("PreToolUse", failReason))
			return
		}

		for _, cand := range g.candidates {
			projectID := computeProjectID(cand.RepoRoot)
			if isGateDisabled(projectID) {
				continue
			}
			prefix := cand.DirName + "/"
			creates := filterAndStripPrefix(extracted.Creates, prefix)
			touches := filterAndStripPrefix(extracted.Touches, prefix)
			if len(creates) == 0 && len(touches) == 0 {
				continue // this plan doesn't touch this candidate at all
			}
			matchedAny = true

			reqBody := designCheckRequest{
				ProjectID: projectID,
				SessionID: payload.SessionID,
				Creates:   creates,
				Touches:   touches,
				DependsOn: extracted.DependsOn,
				Summary:   extracted.Summary,
			}
			result, failReason := postDesignCheck(cfg.ServerURL, cfg.AuthToken, developerID, reqBody)
			if failReason != "" {
				writeJSON(denyOutput("PreToolUse", failReason))
				return
			}
			switch {
			case result.Verdict == "clean", !result.blocksGate():
				// no-op -- allowed overall unless something else denies.
				// The second case is 2026-08-19's severity split: a
				// "warning"-severity "overlap" (tier 1 only) registers and
				// allows same as clean, same reasoning as the single-repo
				// path above.
			case result.Verdict == "overlap":
				denyReasons = append(denyReasons, fmt.Sprintf("[%s] %s", cand.DirName, overlapReason(result)))
			case result.Verdict == "constraint_flag":
				denyReasons = append(denyReasons, fmt.Sprintf("[%s] %s", cand.DirName, constraintReason(result)))
			default:
				logDesignGate("ExitPlanMode multi-candidate check: unknown verdict %q for %s (blocking)", result.Verdict, cand.DirName)
				writeJSON(coordinatorErrorOutput("PreToolUse", fmt.Sprintf("unknown verdict %q", result.Verdict)))
				return
			}
		}
	}

	if !matchedAny {
		// The plan mentions no concrete path inside any onboarded candidate
		// -- deliberately not a guess-and-register-everywhere: this gate
		// doesn't fail open, and registering in every candidate unfiltered
		// would be exactly that.
		writeJSON(denyOutput("PreToolUse", ambiguousMultiRepoReason(candidates)))
		return
	}
	if len(denyReasons) > 0 {
		writeJSON(denyOutput("PreToolUse", strings.Join(denyReasons, "\n\n")))
		return
	}
	writeJSON(allowOutput("PreToolUse"))
}

// postDesignCheck posts to /v1/designs/check (structured or rawPlanText,
// per reqBody) and parses the verdict response, applying the same
// fail-closed status handling every check on this path uses. Shared by
// handleExitPlanModeSingle and handleExitPlanModeMultiCandidate so the two
// don't duplicate this boilerplate.
func postDesignCheck(serverURL, authToken, developerID string, reqBody designCheckRequest) (designCheckResponse, string) {
	res, err := postJSON(strings.TrimRight(serverURL, "/")+"/v1/designs/check", reqBody, designExtractionTimeout, authToken, developerID)
	if err != nil {
		logDesignGate("designs/check failed (blocking): %v", err)
		return designCheckResponse{}, unreachableReason(err)
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden {
		logDesignGate("designs/check returned status %d (blocking)", res.StatusCode)
		return designCheckResponse{}, authRejectedReason()
	}
	if res.StatusCode != http.StatusOK {
		logDesignGate("designs/check returned status %d (blocking)", res.StatusCode)
		return designCheckResponse{}, coordinatorErrorReason(fmt.Sprintf("unexpected status %d", res.StatusCode))
	}
	body, err := io.ReadAll(res.Body)
	if err != nil {
		logDesignGate("designs/check: failed reading response body (blocking): %v", err)
		return designCheckResponse{}, coordinatorErrorReason("failed reading response body")
	}
	var result designCheckResponse
	if err := json.Unmarshal(body, &result); err != nil {
		logDesignGate("designs/check: malformed response (blocking): %v", err)
		return designCheckResponse{}, coordinatorErrorReason("malformed response")
	}
	return result, ""
}

// postDesignExtract posts to the project-agnostic POST /v1/designs/extract
// (extraction only, no registration -- app.ts) used by
// handleExitPlanModeMultiCandidate to extract a plan once before deciding
// which candidate repo(s) it belongs to. Same fail-closed status handling
// as postDesignCheck.
func postDesignExtract(serverURL, authToken, developerID, planText string) (designExtractResponse, string) {
	reqBody := struct {
		RawPlanText string `json:"rawPlanText"`
	}{RawPlanText: planText}
	res, err := postJSON(strings.TrimRight(serverURL, "/")+"/v1/designs/extract", reqBody, designExtractionTimeout, authToken, developerID)
	if err != nil {
		logDesignGate("designs/extract failed (blocking): %v", err)
		return designExtractResponse{}, unreachableReason(err)
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden {
		logDesignGate("designs/extract returned status %d (blocking)", res.StatusCode)
		return designExtractResponse{}, authRejectedReason()
	}
	if res.StatusCode != http.StatusOK {
		logDesignGate("designs/extract returned status %d (blocking)", res.StatusCode)
		return designExtractResponse{}, coordinatorErrorReason(fmt.Sprintf("unexpected status %d", res.StatusCode))
	}
	body, err := io.ReadAll(res.Body)
	if err != nil {
		logDesignGate("designs/extract: failed reading response body (blocking): %v", err)
		return designExtractResponse{}, coordinatorErrorReason("failed reading response body")
	}
	var result designExtractResponse
	if err := json.Unmarshal(body, &result); err != nil {
		logDesignGate("designs/extract: malformed response (blocking): %v", err)
		return designExtractResponse{}, coordinatorErrorReason("malformed response")
	}
	return result, ""
}

// filterAndStripPrefix keeps only entries beginning with prefix, stripped
// of that prefix -- e.g. "TwingMail/packages/api/mailbox.ts" with prefix
// "TwingMail/" becomes "packages/api/mailbox.ts", matching what that
// repo's own designs/constraints declare (repo-relative, never prefixed
// with the repo's own directory name).
func filterAndStripPrefix(paths []string, prefix string) []string {
	var out []string
	for _, p := range paths {
		if strings.HasPrefix(p, prefix) {
			out = append(out, strings.TrimPrefix(p, prefix))
		}
	}
	return out
}

// ambiguousMultiRepoReason is handleExitPlanModeMultiCandidate's deny
// message for the residual case: a plan that mentions no concrete file
// path inside any onboarded candidate repo, so there's nothing to
// partition on. Deliberately a deny, not a guess.
func ambiguousMultiRepoReason(candidates []childCoordinator) string {
	names := make([]string, len(candidates))
	for i, c := range candidates {
		names[i] = c.DirName
	}
	return fmt.Sprintf(
		"twing design coordinator: this session's working directory isn't itself a git repo, and spans multiple "+
			"onboarded repos (%s), but the plan doesn't mention a concrete file path inside any of them, so twing "+
			"can't tell which project(s) to register it against. Either mention concrete paths in the plan (e.g. "+
			"\"%s/path/to/file.ts\"), or re-run ExitPlanMode from inside the specific repo this work belongs to.",
		strings.Join(names, ", "), names[0],
	)
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

func designScopeMatchURL(serverURL, projectID, sessionID, filePath string) string {
	u := fmt.Sprintf("%s/v1/designs/scope-match?projectId=%s&sessionId=%s",
		strings.TrimRight(serverURL, "/"), url.QueryEscape(projectID), url.QueryEscape(sessionID))
	if filePath != "" {
		u += "&path=" + url.QueryEscape(filePath)
	}
	return u
}

type designScopeMatchResponse struct {
	State    string `json:"state"` // "no_design" | "flagged" | "dormant" | "in_scope" | "out_of_scope"
	DesignID string `json:"designId,omitempty"`
	// Set only for state "dormant" (§17 design lifecycle, 2026-08) -- enough
	// context for whoever decides (agent or the human supervising it) to
	// actually judge "same task or not", not just retry a denied command.
	Summary        string `json:"summary,omitempty"`
	DormantSinceMs int64  `json:"dormantSinceMs,omitempty"`
	// Set only for state "flagged" (found live, 2026-08-16) -- distinguishes
	// "never resolved" from "resolved, an admin just hasn't decided yet".
	// Both used to deny with the identical message telling you to run
	// `twing design resolve`, even immediately after you already had.
	PendingReview bool `json:"pendingReview,omitempty"`
}

// checkDesignScope is §17 scope enforcement's (2026-08) ground-truth
// backstop for a design's *own* claim: checks the literal file being edited
// against the session's own open design(s) directly, instead of trusting
// "the session has *a* design registered" as proof enough. Same fail-closed
// shape as checkPathConstraint -- a network/auth/parse error here returns a
// non-empty failReason, never a silent "in_scope".
func checkDesignScope(serverURL, authToken, developerID, projectID, sessionID, filePath string) (result designScopeMatchResponse, failReason string) {
	res, err := getJSON(designScopeMatchURL(serverURL, projectID, sessionID, filePath), authToken, developerID)
	if err != nil {
		logDesignGate("design scope check failed (blocking): %v", err)
		return designScopeMatchResponse{}, unreachableReason(err)
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden {
		logDesignGate("design scope check returned status %d (blocking)", res.StatusCode)
		return designScopeMatchResponse{}, authRejectedReason()
	}
	if res.StatusCode != http.StatusOK {
		logDesignGate("design scope check returned status %d (blocking)", res.StatusCode)
		return designScopeMatchResponse{}, coordinatorErrorReason(fmt.Sprintf("unexpected status %d", res.StatusCode))
	}
	body, err := io.ReadAll(res.Body)
	if err != nil {
		logDesignGate("design scope check: failed reading response body (blocking): %v", err)
		return designScopeMatchResponse{}, coordinatorErrorReason("failed reading response body")
	}
	if err := json.Unmarshal(body, &result); err != nil {
		logDesignGate("design scope check: malformed response (blocking): %v", err)
		return designScopeMatchResponse{}, coordinatorErrorReason("malformed response")
	}
	return result, ""
}

func flaggedDesignReason(designID string, pendingReview bool) string {
	if pendingReview {
		return fmt.Sprintf(
			"twing design coordinator: your registered design (id %s) has a justified-divergence review "+
				"already pending -- nothing more to do on your end. An admin needs to approve or reject it "+
				"(`twing design reviews`) before this design counts as usable again. Retrying won't help until "+
				"then.",
			designID,
		)
	}
	return fmt.Sprintf(
		"twing design coordinator: your registered design (id %s) has an unresolved overlap/constraint "+
			"conflict from its own registration -- it doesn't count as a usable open design until you resolve "+
			"it. Run `twing design resolve --id %s (--adopt <designId> | --justify \"<reason>\")`, then retry this edit.",
		designID, designID,
	)
}

func outOfScopeReason(designID, path string) string {
	return fmt.Sprintf(
		"twing design coordinator: %s isn't in your registered design's declared scope (id %s). Either run "+
			"`twing design amend --id %s --touches %s` (re-checked against other open designs/constraints, doesn't "+
			"just silently expand your scope), or register a separate design if this is genuinely unrelated work.",
		path, designID, designID, path,
	)
}

// dormantSinceText renders a millisecond duration as a coarse,
// human-readable approximation ("3h", "2d") -- just enough for a reader to
// judge "recently" vs "a while ago", not a precise timestamp.
func dormantSinceText(ms int64) string {
	d := time.Duration(ms) * time.Millisecond
	if d < time.Hour {
		return fmt.Sprintf("%dm", int(d.Minutes()))
	}
	if d < 24*time.Hour {
		return fmt.Sprintf("%dh", int(d.Hours()))
	}
	return fmt.Sprintf("%dd", int(d.Hours()/24))
}

// dormantDesignReason is §17 design lifecycle's (2026-08) counterpart to
// flaggedDesignReason/outOfScopeReason -- deliberately never a silent
// allow-and-wake: a file matching a dormant design's declared scope isn't
// proof of intent to resume it (a single long-lived session can register
// design A, abandon it, and later touch a file A happens to cover for
// entirely unrelated reasons), so this always denies and shows enough
// context (summary, how long dormant) for whoever decides to actually
// judge "same task or not" before running `twing design resume`.
func dormantDesignReason(designID, summary string, dormantSinceMs int64) string {
	return fmt.Sprintf(
		"twing design coordinator: this file matches design %s (%q), which has been dormant (no activity) for "+
			"~%s. It's not resumed automatically -- if this really is the same task, run `twing design resume --id %s "+
			"[--touches <path>]` (re-checked against everything currently open before it reactivates). If it's "+
			"unrelated, register a separate design instead.",
		designID, summary, dormantSinceText(dormantSinceMs), designID,
	)
}

// sessionID is optional (empty string omits the query param entirely) --
// see checkPathConstraint's comment for why it's passed at all now.
func constraintMatchURL(serverURL, projectID, path, sessionID string) string {
	u := fmt.Sprintf("%s/v1/constraints/match?projectId=%s&path=%s",
		strings.TrimRight(serverURL, "/"), url.QueryEscape(projectID), url.QueryEscape(path))
	if sessionID != "" {
		u += "&sessionId=" + url.QueryEscape(sessionID)
	}
	return u
}

type constraintMatchResponse struct {
	Matched    bool                  `json:"matched"`
	Constraint *designConstraintInfo `json:"constraint,omitempty"`
}

// constraintCheckResult is checkPathConstraint's tri-state verdict --
// "we couldn't tell" (constraintCheckFailed) is deliberately not folded
// into "clear": a failed check must deny, same as a failed open-designs
// lookup, not be silently treated as "no constraint matched".
type constraintCheckResult int

const (
	constraintClear constraintCheckResult = iota
	constraintMatched
	constraintCheckFailed
)

// checkPathConstraint is §17.9's ground-truth backstop: checks the literal
// file being edited against the Constraint Store directly, independent of
// whatever the session's registered design claims to touch. Fail-closed
// like every other check on this path -- a network/auth/parse error here
// returns constraintCheckFailed with a reason, not a silent "clear".
//
// sessionID (added 2026-08-17, fixing a live-reproduced bug): lets the
// server exclude a constraint already justified-and-approved for this
// session's own *open* design, so an approved justification actually
// unblocks future edits instead of denying identically forever. The
// original anti-bypass property this check exists for is unchanged -- a
// session with no design, an unrelated design, or an unjustified
// constraint still gets denied exactly as before; only the
// already-reviewed-and-approved case behaves differently now.
func checkPathConstraint(serverURL, authToken, developerID, projectID, sessionID, filePath string) (constraintCheckResult, string) {
	res, err := getJSON(constraintMatchURL(serverURL, projectID, filePath, sessionID), authToken, developerID)
	if err != nil {
		logDesignGate("constraint match check failed (blocking): %v", err)
		return constraintCheckFailed, unreachableReason(err)
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden {
		logDesignGate("constraint match check returned status %d (blocking)", res.StatusCode)
		return constraintCheckFailed, authRejectedReason()
	}
	if res.StatusCode != http.StatusOK {
		logDesignGate("constraint match check returned status %d (blocking)", res.StatusCode)
		return constraintCheckFailed, coordinatorErrorReason(fmt.Sprintf("unexpected status %d", res.StatusCode))
	}
	body, err := io.ReadAll(res.Body)
	if err != nil {
		logDesignGate("constraint match check: failed reading response body (blocking): %v", err)
		return constraintCheckFailed, coordinatorErrorReason("failed reading response body")
	}
	var result constraintMatchResponse
	if err := json.Unmarshal(body, &result); err != nil {
		logDesignGate("constraint match check: malformed response (blocking): %v", err)
		return constraintCheckFailed, coordinatorErrorReason("malformed response")
	}
	if !result.Matched || result.Constraint == nil {
		return constraintClear, ""
	}
	return constraintMatched, fmt.Sprintf(
		"twing design coordinator: %s is covered by an existing %s rule: %q. This applies regardless of what your "+
			"registered design claims to touch. If this is intentional and reviewed, record it as a justified "+
			"divergence: `twing design resolve --id <your-design-id> --justify \"<reason>\"` (queues for human "+
			"review -- an admin approving it is what unblocks you, not the justify call itself).",
		filePath, result.Constraint.Type, result.Constraint.Statement,
	)
}

// handleEditWriteGate is the universal fallback (§17/spec §9a): if an agent
// skips plan mode entirely, this is what actually gets a design registered
// before its first write. As of §17.9, it also checks the specific file
// against the Constraint Store directly (ground truth) before falling back
// to the design-scope check -- a session can't sidestep a review_required
// rule just by registering an unrelated design first. As of §17 scope
// enforcement (2026-08), "has any open design" is no longer sufficient by
// itself: /v1/designs/scope-match additionally checks the file against that
// design's own declared creates/touches (ground truth, same reasoning as
// §17.9 but against the design's own claim instead of a constraint), and
// distinguishes "nothing registered" from "something's registered but its
// own verdict flagged a conflict" -- previously indistinguishable from a
// clean design as far as this gate was concerned.
func handleEditWriteGate(payload hookPayload) {
	var input struct {
		FilePath string `json:"file_path"`
	}
	_ = json.Unmarshal(payload.ToolInput, &input)

	// Resolved from the file's own path, not cwd (fix, 2026-08-18): a
	// session whose cwd is a shared parent of several independently
	// onboarded repos (e.g. a backend + its separate UI repo) previously
	// resolved no coordinator at all here, since cwd itself wasn't inside
	// any git repo -- see resolveServerConfigForFile's own doc comment.
	config := resolveServerConfigForFile(payload.Cwd, input.FilePath)
	if config.ServerURL == "" {
		return
	}

	// Resolve once, use everywhere below -- both the constraint check and
	// the scope-match check compare against repo-relative declarations
	// (design-store.ts/manifest.ts never store absolute paths), so the raw
	// absolute file_path Claude Code actually sends must be converted
	// before either call, not passed through raw. This also covers "this
	// repo's coordinator has no jurisdiction over a write that isn't even
	// part of this repo" (e.g. Claude Code's own plan files under
	// ~/.claude/plans/): resolveRepoRelative's ok=false there is exactly
	// the same "not this coordinator's concern" case "no coordinator
	// configured" already gets, so it's treated identically -- silent
	// allow, never a call into scope/constraint logic that assumes the
	// target is in-repo.
	relPath := ""
	if input.FilePath != "" {
		rel, ok := resolveRepoRelative(payload.Cwd, config.RepoRoot, input.FilePath)
		if !ok {
			logDesignGate("path %s is outside repo %s -- skipping gate", input.FilePath, config.RepoRoot)
			return
		}
		relPath = rel
	}

	// config.RepoRoot (not payload.Cwd) -- it's already the resolved,
	// canonical repo root at this point (guaranteed non-empty once
	// config.ServerURL != ""), so this avoids a second, potentially
	// divergent `git` shell-out against cwd, and stays correct when cwd
	// itself isn't the repo the edited file lives in.
	projectID := computeProjectID(config.RepoRoot)

	// Per-repo override (`twing design disable-gate`) -- silent allow, same
	// category as "no coordinator configured": this machine has
	// deliberately opted this project out, not a failure.
	if isGateDisabled(projectID) {
		return
	}

	if config.AuthToken == "" && !config.NoAuth {
		writeJSON(authRequiredOutput("PreToolUse", config.ServerURL))
		return
	}
	developerID := ""
	if config.NoAuth {
		developerID = computeDeveloperID(config.RepoRoot)
	}

	if relPath != "" {
		verdict, reason := checkPathConstraint(config.ServerURL, config.AuthToken, developerID, projectID, payload.SessionID, relPath)
		if verdict == constraintMatched || verdict == constraintCheckFailed {
			writeJSON(denyOutput("PreToolUse", reason))
			return
		}
	}

	scopeMatch, failReason := checkDesignScope(config.ServerURL, config.AuthToken, developerID, projectID, payload.SessionID, relPath)
	if failReason != "" {
		writeJSON(denyOutput("PreToolUse", failReason))
		return
	}

	switch scopeMatch.State {
	case "in_scope":
		writeJSON(allowOutput("PreToolUse"))
	case "flagged":
		writeJSON(denyOutput("PreToolUse", flaggedDesignReason(scopeMatch.DesignID, scopeMatch.PendingReview)))
	case "dormant":
		writeJSON(denyOutput("PreToolUse", dormantDesignReason(scopeMatch.DesignID, scopeMatch.Summary, scopeMatch.DormantSinceMs)))
	case "out_of_scope":
		writeJSON(denyOutput("PreToolUse", outOfScopeReason(scopeMatch.DesignID, relPath)))
	case "no_design":
		writeJSON(denyOutput("PreToolUse",
			"twing design coordinator: no design registered for this session yet. Either enter plan mode "+
				"(ExitPlanMode registers one automatically), or run `twing design register --summary "+
				"\"<what you are trying to achieve in this session, concretely>\" --creates a,b --touches c,d "+
				"--depends-on e,f` directly, then retry this edit. The summary is what other sessions and human "+
				"reviewers see when your work overlaps theirs -- describe the actual goal, not a placeholder.",
		))
	default:
		logDesignGate("design scope check: unknown state %q (blocking)", scopeMatch.State)
		writeJSON(coordinatorErrorOutput("PreToolUse", fmt.Sprintf("unknown state %q", scopeMatch.State)))
	}
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
	developerID := ""
	if config.NoAuth {
		developerID = computeDeveloperID(payload.Cwd)
	}
	res, err := getJSON(openDesignsURL(config.ServerURL, projectID, payload.SessionID), config.AuthToken, developerID)
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
		setAuthHeader(req, config.AuthToken, developerID)
		if resp, err := client.Do(req); err == nil {
			resp.Body.Close()
		}
	}
}
