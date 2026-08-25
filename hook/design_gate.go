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
	// GroupID (§17 design linking, 2026-08): cross-project label linking
	// this design to sibling DesignStatement rows registered in other
	// repos for the same unit of work. Optional -- self-assigned
	// server-side (to this design's own new id) when omitted. Only
	// handleExitPlanModeMultiCandidate sets it today: it mints one fresh
	// id per plan invocation (generateGroupID, identity.go) and reuses it
	// across every matching candidate's registration call in that same
	// pass, so a multi-repo plan's rows link automatically with zero
	// extra agent action. handleExitPlanModeSingle deliberately never
	// sets this -- a genuinely single-repo plan gets no group beyond the
	// default "group of one" the server assigns anyway.
	GroupID string `json:"groupId,omitempty"`
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
	Verdict   string           `json:"verdict"`
	DesignID  string           `json:"designId"`
	Conflicts []designConflict `json:"conflicts,omitempty"`
	// Every constraint the checked scope matched (2026-08-22, was a single
	// `Constraint` -- see design-checks.ts's matchConstraintsForPaths doc
	// comment for why this is a list now).
	Constraints []designConstraintInfo `json:"constraints,omitempty"`
	// Severity (2026-08-19, design-checks.ts's severity split): "warning" |
	// "error" | "" (empty on a "clean" verdict, where it's moot). Only an
	// "error" verdict denies here -- a "warning" (currently tier 1's
	// exactOverlap only) is display-only, same as "clean" as far as this
	// gate is concerned. See DesignSeverity's doc comment in core/types.ts.
	Severity string `json:"severity,omitempty"`
	// GroupID (§17 design linking, 2026-08): echoes back the design's own
	// groupId (self-assigned or caller-supplied). Not consumed by any
	// gate decision today -- available for future logging/diagnostics.
	GroupID string `json:"groupId,omitempty"`
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
// Separated by a rule and explicitly addressed, so a human reading the deny
// can see at a glance that this paragraph isn't aimed at them -- before this
// it ran straight on from the user-facing text, which made an already-dense
// message read as one undifferentiated wall.
const agentInstructionSuffix = "\n\n---\nNote for the agent: this is twing's coordination gate, not a bug to\n" +
	"route around. If you resolve it yourself, say so explicitly in your reply\n" +
	"to the operator -- what you did and why, not a silent retry-and-succeed.\n" +
	"It creates a persistent record under their identity. See twing-cli's\n" +
	"README, \"For agents: handling a design-gate deny\", for the full\n" +
	"explanation."

// Every deny message this file produces follows one three-layer grammar:
//
//  1. headline -- one plain sentence, no identifiers, no jargon. The only
//     line most readers will actually read.
//  2. why + details -- indented context, for whoever wants it.
//  3. "What now" -- the exact commands.
//
// Rendering constraints, all driven by the fact that we do not own the
// renderer: this string is JSON (see writeJSON) handed to Claude Code, and
// the same text is also read by the agent. So no ANSI colour (it would
// arrive as literal escape bytes and pollute the model's context) and no
// emoji or box-drawing. Structure is the only formatting available, which
// is why prose is hard-wrapped rather than left to the terminal.
const (
	denyIndent           = "  "
	denyActionIndent     = "    "
	denyCommandIndent    = "      "
	denyDetailLabelWidth = 14
	denyWrapWidth        = 72
)

// denyDetail is one "label  value" row in a deny message's detail block. A
// zero value renders as a blank separator line, for messages that list
// several conflicts or rules.
type denyDetail struct{ Label, Value string }

// denyAction is one entry under "What now": what it achieves, the command
// that does it (optional -- some actions are advice, not a command), and an
// optional caveat. The command lives on its own line rather than beside the
// label because a real design id is a 36-character UUID, which blows any
// label-plus-command line well past a sane terminal width.
type denyAction struct {
	Label   string
	Command string
	Note    string
}

// wrapText hard-wraps prose at width, preserving nothing but word breaks --
// deny text has no intentional internal line structure to protect.
func wrapText(s string, width int) []string {
	words := strings.Fields(s)
	if len(words) == 0 {
		return nil
	}
	lines := []string{}
	current := words[0]
	for _, w := range words[1:] {
		if len(current)+1+len(w) > width {
			lines = append(lines, current)
			current = w
			continue
		}
		current += " " + w
	}
	return append(lines, current)
}

func writeWrapped(b *strings.Builder, text, indent string) {
	for _, line := range wrapText(text, denyWrapWidth-len(indent)) {
		b.WriteString("\n" + indent + line)
	}
}

// denyMessage assembles the three layers. Every *Reason function below goes
// through it, so the messages cannot drift apart into separate dialects.
func denyMessage(headline, why string, details []denyDetail, actions []denyAction) string {
	var b strings.Builder
	b.WriteString(headline)

	if why != "" {
		b.WriteString("\n")
		writeWrapped(&b, why, denyIndent)
	}

	if len(details) > 0 {
		b.WriteString("\n")
		for _, d := range details {
			if d.Label == "" && d.Value == "" {
				b.WriteString("\n")
				continue
			}
			if d.Label == "" {
				b.WriteString("\n" + denyIndent + strings.Repeat(" ", denyDetailLabelWidth) + d.Value)
				continue
			}
			fmt.Fprintf(&b, "\n%s%-*s%s", denyIndent, denyDetailLabelWidth, d.Label, d.Value)
		}
	}

	if len(actions) > 0 {
		b.WriteString("\n\n" + denyIndent + "What now")
		for _, a := range actions {
			b.WriteString("\n" + denyActionIndent + a.Label)
			if a.Command != "" {
				b.WriteString("\n" + denyCommandIndent + a.Command)
			}
			if a.Note != "" {
				writeWrapped(&b, a.Note, denyCommandIndent)
			}
		}
	}

	return b.String()
}

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

// gateOffAction is the same escape hatch on every failure-path message --
// none of these are the user's fault, so each one says how to keep working.
var gateOffAction = denyAction{
	Label:   "Or work without conflict checking",
	Command: "TWING_DESIGN_GATE=off",
	Note:    "Turns the gate off for this session. Nothing else is affected.",
}

const failClosedWhy = "twing blocks rather than risk letting two people edit the same thing " +
	"without either of them noticing."

func authRequiredReason(serverURL string) string {
	return denyMessage(
		"twing can't check for conflicts -- this machine isn't signed in.",
		failClosedWhy,
		[]denyDetail{{"Coordinator", serverURL}},
		[]denyAction{
			{Label: "Sign in", Command: fmt.Sprintf("twing login --server %s", serverURL)},
			{Label: "Or set this repo up from scratch", Command: "twing init"},
			gateOffAction,
		},
	)
}

// authRejectedReason splits 401 from 403 (2026-08-24). They are genuinely
// different problems with different fixes, and collapsing them cost a real
// user five days: the message said "your cached token is stale -- run twing
// login", but the actual cause was a 403 (the developer simply wasn't a
// member of that project yet), which `twing login` cannot fix. A 401 is
// "we don't know this token"; a 403 is "we know you, this project doesn't
// admit you."
func authRejectedReason(status int, serverURL string) string {
	if status == http.StatusForbidden {
		return denyMessage(
			"twing can't check for conflicts -- you don't have access to this project.",
			"Your sign-in worked, but this project didn't accept it. Usually that means "+
				"you haven't been added to it yet. "+failClosedWhy,
			[]denyDetail{{"Coordinator", serverURL}, {"Response", "403 access denied"}},
			[]denyAction{
				{
					Label:   "Join this project",
					Command: "twing join --github",
					Note:    "Run this from inside this repo. It uses your GitHub access to decide your role.",
				},
				{Label: "See what you currently have access to", Command: "twing whoami"},
				gateOffAction,
			},
		)
	}
	return denyMessage(
		"twing can't check for conflicts -- your sign-in was rejected.",
		"The coordinator didn't recognise this machine's saved credentials. They may have "+
			"expired or been revoked. "+failClosedWhy,
		[]denyDetail{{"Coordinator", serverURL}, {"Response", "401 not recognised"}},
		[]denyAction{
			{Label: "Sign in again", Command: "twing join --github", Note: "Run this from inside this repo."},
			gateOffAction,
		},
	)
}

func unreachableReason(err error) string {
	return denyMessage(
		"twing can't reach the coordinator to check for conflicts.",
		failClosedWhy,
		[]denyDetail{{"Error", fmt.Sprintf("%v", err)}},
		[]denyAction{
			{Label: "Check your connection, then retry"},
			gateOffAction,
		},
	)
}

func coordinatorErrorReason(detail string) string {
	return denyMessage(
		"twing got an answer it didn't understand from the coordinator.",
		failClosedWhy,
		[]denyDetail{{"Detail", detail}},
		[]denyAction{
			{Label: "Retry -- this is usually temporary"},
			gateOffAction,
		},
	)
}

func authRequiredOutput(eventName, serverURL string) map[string]any {
	return denyOutput(eventName, authRequiredReason(serverURL))
}

func authRejectedOutput(eventName string, status int, serverURL string) map[string]any {
	return denyOutput(eventName, authRejectedReason(status, serverURL))
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

	// §17 design linking (2026-08): one groupId per plan invocation, shared
	// across every candidate this plan matches below -- see
	// generateGroupID's doc comment (identity.go).
	groupID := generateGroupID()

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
				GroupID:   groupID,
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
		return designCheckResponse{}, authRejectedReason(res.StatusCode, serverURL)
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
		return designExtractResponse{}, authRejectedReason(res.StatusCode, serverURL)
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
	return denyMessage(
		"twing can't tell which project this work belongs to.",
		"This folder isn't a git repo itself, and it contains several repos that use "+
			"twing. Your plan doesn't mention a file inside any of them, so there's "+
			"nothing to match on.",
		[]denyDetail{{"Repos here", strings.Join(names, ", ")}},
		[]denyAction{
			{
				Label: "Mention a real file path in your plan",
				Note:  fmt.Sprintf("For example: %s/path/to/file.ts", names[0]),
			},
			{
				Label: "Or plan from inside the repo this work belongs to",
				Note:  "Start a session there and twing will know which project you mean.",
			},
		},
	)
}

// noDesignReason was an inline string at its single call site until
// 2026-08-24 -- extracted so it can be tested alongside every other deny
// message, and so it goes through the same formatter rather than drifting.
func noDesignReason() string {
	return denyMessage(
		"Before your first edit, twing needs to know what you're building.",
		"Other people -- and other AI sessions -- may be working in this same code "+
			"right now. Saying what you're doing lets twing warn you before two of "+
			"you collide.",
		nil,
		[]denyAction{
			{
				Label: "Let plan mode do it for you",
				Note:  "Finishing a plan registers this automatically. Nothing else to run.",
			},
			{
				Label:   "Or say it yourself",
				Command: "twing design register --summary \"<the goal>\" --touches <files>",
				Note: "The summary is what teammates see if your work overlaps theirs, " +
					"so describe the real goal rather than a placeholder.",
			},
		},
	)
}

func overlapReason(result designCheckResponse) string {
	headline := "Someone else is already planning similar work."
	if len(result.Conflicts) > 1 {
		headline = "Other people are already planning similar work."
	}

	details := []denyDetail{}
	for i, c := range result.Conflicts {
		if i > 0 {
			details = append(details, denyDetail{})
		}
		details = append(details,
			denyDetail{"Their plan", c.ConflictingSummary},
			denyDetail{"", "design " + c.ConflictingDesignID},
			denyDetail{"Why it clashes", c.OverlapDetail},
		)
	}

	return denyMessage(
		headline,
		"twing compared your plan against everything else being worked on right now.",
		details,
		[]denyAction{
			{
				Label: "Build on their work instead",
				Note:  "Adjust your plan so it extends theirs, then finish planning again.",
			},
			{
				Label:   "Or explain why yours needs to be separate",
				Command: fmt.Sprintf("twing design resolve --id %s --justify \"<reason>\"", result.DesignID),
				Note:    "This goes to a project admin. You stay blocked until they decide.",
			},
		},
	)
}

// constraintTypeText translates a constraint's machine type into something
// a reader who has never opened .twing/twing.yml can act on.
func constraintTypeText(t string) string {
	switch t {
	case "review_required":
		return "a human must review changes here"
	case "canonical_abstraction":
		return "use the existing approach, don't add a second one"
	case "domain_fact":
		return "a fact about this codebase you should not contradict"
	default:
		return t
	}
}

// constraintReason lists every matched constraint (2026-08-22, was a single
// statement/type pair) -- mirrors overlapReason's own loop over
// result.Conflicts just above it in this file, so a session sees every
// violation from one ExitPlanMode call instead of discovering the next one
// only after justifying and retrying.
func constraintReason(result designCheckResponse) string {
	details := []denyDetail{}
	for i, c := range result.Constraints {
		if i > 0 {
			details = append(details, denyDetail{})
		}
		details = append(details,
			denyDetail{"Rule", c.Statement},
			denyDetail{"", "(" + constraintTypeText(c.Type) + ")"},
		)
	}

	return denyMessage(
		"This work touches something your team has protected.",
		"Your team registered rules for these areas of the codebase. They apply to "+
			"everyone, and they're checked before any edit goes through.",
		details,
		[]denyAction{
			{
				Label: "Adjust your plan to comply",
				Note:  "Then finish planning again and it'll be re-checked.",
			},
			{
				Label:   "Or explain why it can't comply",
				Command: fmt.Sprintf("twing design resolve --id %s --justify \"<reason>\"", result.DesignID),
				Note:    "This goes to a project admin. You stay blocked until they decide.",
			},
		},
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
		return designScopeMatchResponse{}, authRejectedReason(res.StatusCode, serverURL)
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

// The "unresolved ... from its own registration" wording this replaced was
// wrong as of the async semantic comparator (2026-08-22): a design can be
// flagged minutes after a clean registration, by runSemanticComparatorPass,
// so the conflict frequently did not come from registration at all.
func flaggedDesignReason(designID string, pendingReview bool) string {
	if pendingReview {
		return denyMessage(
			"You're waiting on a person, not on twing.",
			"Your explanation has been sent to a project admin. There's nothing more to do "+
				"on your end -- retrying won't help until someone decides.",
			[]denyDetail{{"Your plan", designID}, {"Status", "waiting for review"}},
			[]denyAction{
				{Label: "Check where it stands", Command: "twing design reviews"},
				{Label: "Or ask a project admin to take a look"},
			},
		)
	}
	return denyMessage(
		"Someone else may already be doing this work.",
		"twing compared your plan against other active sessions and found a conflict, "+
			"so this edit is on hold until that's settled.",
		[]denyDetail{{"Your plan", designID}, {"Status", "on hold until resolved"}},
		[]denyAction{
			{
				Label:   "Build on their work instead",
				Command: fmt.Sprintf("twing design resolve --id %s --adopt <theirPlanId>", designID),
			},
			{
				Label:   "Or explain why yours needs to be separate",
				Command: fmt.Sprintf("twing design resolve --id %s --justify \"<reason>\"", designID),
				Note:    "This goes to a project admin. You stay blocked until they decide.",
			},
		},
	)
}

func outOfScopeReason(designID, path string) string {
	return denyMessage(
		"You're changing a file you didn't mention in your plan.",
		"twing can't tell whether that's a natural part of your work or the start of a "+
			"collision with someone else, so it's asking first.",
		[]denyDetail{{"File", path}, {"Your plan", designID}},
		[]denyAction{
			{
				Label:   "Add it to your plan",
				Command: fmt.Sprintf("twing design amend --id %s --touches %s", designID, path),
				Note:    "This is re-checked against other active sessions, not a silent expansion.",
			},
			{
				Label: "Or register a separate plan",
				Note:  "Use this if the change is genuinely unrelated to what you registered.",
			},
		},
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
	details := []denyDetail{{"Paused task", designID}}
	if summary != "" {
		details = append(details, denyDetail{"What it was", summary})
	}
	details = append(details, denyDetail{"Idle for", "~" + dormantSinceText(dormantSinceMs)})

	return denyMessage(
		"This file belongs to a task that was paused.",
		"A plan covering this file has had no activity for a while. twing doesn't "+
			"restart it on its own, in case it was set aside deliberately.",
		details,
		[]denyAction{
			{
				Label:   "Pick it back up",
				Command: fmt.Sprintf("twing design resume --id %s", designID),
				Note:    "Re-checked against everything currently active before it restarts.",
			},
			{
				Label: "Or register a new plan",
				Note:  "Use this if your current work is unrelated to the paused task.",
			},
		},
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
	Matched     bool                   `json:"matched"`
	Constraints []designConstraintInfo `json:"constraints,omitempty"`
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
		return constraintCheckFailed, authRejectedReason(res.StatusCode, serverURL)
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
	if !result.Matched || len(result.Constraints) == 0 {
		return constraintClear, ""
	}
	// Lists every matched constraint (2026-08-22, was a single %s rule: %q
	// pair) -- same reasoning as constraintReason above: a file covered by
	// several rules at once should deny with all of them named up front.
	var b strings.Builder
	fmt.Fprintf(&b, "twing design coordinator: %s is covered by %d existing rule(s):", filePath, len(result.Constraints))
	for _, c := range result.Constraints {
		fmt.Fprintf(&b, "\n- [%s] %s", c.Type, c.Statement)
	}
	fmt.Fprintf(&b, "\n\nThis applies regardless of what your registered design claims to touch. If this is "+
		"intentional and reviewed, record it as a justified divergence: `twing design resolve --id "+
		"<your-design-id> --justify \"<reason>\"` (queues for human review -- an admin approving it is what "+
		"unblocks you, not the justify call itself).")
	return constraintMatched, b.String()
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
		writeJSON(denyOutput("PreToolUse", noDesignReason()))
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
