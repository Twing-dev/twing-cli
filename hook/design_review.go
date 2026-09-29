package main

// Design review, rendered into the session (2026-09). Two advisory texts,
// both riding the `additionalContext` the capture path already emits on
// SessionStart and UserPromptSubmit, plus one record the gate reads later.
//
//  1. **Open review comments** (reworked 2026-09-27). A reviewer highlighted
//     part of a design this developer owns in twing-monitor and commented,
//     and nobody has resolved it yet. Comments are answered by *people*, in
//     the dashboard -- so all this says is that they exist, where, and how
//     many; never what they say, which would invite the agent to act on
//     them. For designs in other repos that is the whole of it. For the repo
//     being edited it also records the comments per session, and the first
//     edit the gate would otherwise allow is paused once
//     (`reviewBlockReason`, called from design_gate.go) so the agent stops
//     and tells its user. Retrying goes through: the block is there to make
//     sure a person hears about the comments, not to hold work hostage to
//     them.
//
//  2. **The design-link reminder**, which is the more interesting of the
//     two, because of *why* it has to be repeated.
//
// twing cannot write a commit trailer itself. `git commit` runs through Bash,
// and Bash is in no hook matcher by deliberate design (see wire-hooks.ts), so
// twing never sees a commit happen and has no moment at which to add
// anything. The agent has to write the trailer, which makes "has the agent
// been told recently enough to still remember" the entire problem -- and a
// line delivered once at SessionStart is reliably buried by an hour of design
// discussion before the first commit.
//
// So the reminder is re-delivered on `UserPromptSubmit`, which fires on every
// prompt, and rate-limited here so it costs one line every twenty minutes
// rather than one line every turn. Emitting it unconditionally was considered
// and rejected: a line that appears in every single turn is one an agent
// learns to skip, which would defeat the repetition it exists for.
//
// State is one file per (project, session), exactly like session_attempts.go
// next door and for the same reason -- each hook invocation is a fresh
// process with no memory of the last one, and two concurrent sessions in one
// repo must not read-modify-write a shared file.

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// reviewStateDirName sits under ~/.twing/sessions alongside attempts/ and
// capture's own state.
const reviewStateDirName = "review"

// designLinkReminderInterval is how long the reminder stays quiet after being
// emitted. Twenty minutes is a guess with a rationale rather than a measured
// constant: long enough that a working session sees it a handful of times
// rather than every turn, short enough that it is very unlikely to be more
// than one commit stale. A knob, not a load-bearing invariant -- the same
// spirit as DEFAULT_CLAIM_TTL_MS.
const designLinkReminderInterval = 20 * time.Minute

// reviewStateRetention matches attemptRetention: long enough that a session
// paused overnight still suppresses correctly, short enough that the
// directory does not accumulate a year of dead ids.
const reviewStateRetention = 48 * time.Hour

// designTrailerKey mirrors DESIGN_TRAILER_KEY in packages/core/src/types.ts.
// A real Git trailer, so `git log --format=%(trailers)` and every forge that
// parses trailers pick it up without a bespoke parser.
const designTrailerKey = "Twing-Design"

// renderOpenReviews records which comments are open in each project for this
// session (what the gate's one-time block reads), and returns context lines
// for the comments this session has not been told about yet.
//
// `currentProjectID` is the session's cwd repo: the one whose comments get
// the fuller line that mentions the pause, since that is the repo the agent
// is about to edit. Every project named in `reviews` gets its record
// refreshed regardless -- a session can edit files in a repo other than its
// cwd, and the gate keys the block on the edited file's repo.
//
// Told once per session per comment. A new session is told again, and so is
// this one when a new comment arrives; what stops it for good is a reviewer
// resolving the comment, never a local file deciding it was said enough.
func renderOpenReviews(currentProjectID, sessionID string, reviews []openReviewNotice) []string {
	syncOpenReviewRecords(sessionID, reviews)
	if len(reviews) == 0 {
		return nil
	}

	seen := readReviewState(currentProjectID, sessionID)
	var here, elsewhere []openReviewNotice
	var shown []string
	for _, review := range reviews {
		fresh := false
		for _, id := range review.CommentIDs {
			if !seen.hasShownComment(id) {
				fresh = true
				shown = append(shown, id)
			}
		}
		if !fresh {
			continue
		}
		if review.ProjectID == currentProjectID {
			here = append(here, review)
		} else {
			elsewhere = append(elsewhere, review)
		}
	}

	var messages []string
	if len(here) > 0 {
		var b strings.Builder
		b.WriteString("twing: reviewers left comments on your design in this repo, and they are waiting for a person to answer them in twing-monitor:\n")
		writeReviewLines(&b, here)
		b.WriteString("  They are for your user to answer there, not for you to act on. twing will pause the next edit in this repo once, so you can tell them.")
		messages = append(messages, b.String())
	}
	if len(elsewhere) > 0 {
		var b strings.Builder
		b.WriteString("twing: your user has open review comments on designs in other repos, waiting for them in twing-monitor. Mention it to them; there is nothing to do about it here:\n")
		writeReviewLines(&b, elsewhere)
		messages = append(messages, strings.TrimRight(b.String(), "\n"))
	}

	if len(shown) > 0 {
		seen.recordShownComments(shown)
		writeReviewState(currentProjectID, sessionID, seen)
	}
	return messages
}

// writeReviewLines is one line per design: which work, how many comments,
// and where to answer them.
func writeReviewLines(b *strings.Builder, reviews []openReviewNotice) {
	for _, review := range reviews {
		b.WriteString("  - ")
		b.WriteString(strconv.Quote(truncateSummary(review.DesignSummary)))
		fmt.Fprintf(b, ": %d open comment%s", len(review.CommentIDs), plural(len(review.CommentIDs)))
		if review.URL != "" {
			b.WriteString(" -- ")
			b.WriteString(review.URL)
		}
		b.WriteString("\n")
	}
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

// syncOpenReviewRecords rewrites each project's open-comment record for this
// session from the daemon's answer, which is the whole truth: a project that
// has dropped out of `reviews` has no open comments left, so its record is
// emptied rather than left to block on comments a reviewer already resolved.
// That is why it walks this session's existing records as well as the
// projects named now.
func syncOpenReviewRecords(sessionID string, reviews []openReviewNotice) {
	byProject := map[string][]openReviewNotice{}
	for _, review := range reviews {
		if isPlainID(review.ProjectID) {
			byProject[review.ProjectID] = append(byProject[review.ProjectID], review)
		}
	}
	projects := map[string]bool{}
	for projectID := range byProject {
		projects[projectID] = true
	}
	for _, projectID := range projectsWithReviewState(sessionID) {
		projects[projectID] = true
	}

	for projectID := range projects {
		state := readReviewState(projectID, sessionID)
		state.openComments = nil
		state.openDesigns = nil
		for _, review := range byProject[projectID] {
			state.openComments = append(state.openComments, review.CommentIDs...)
			state.openDesigns = append(state.openDesigns, review)
		}
		writeReviewState(projectID, sessionID, state)
	}
}

// projectsWithReviewState lists the projects this session already has a
// record for. Files are named `<projectId>.<sessionId>`, and neither part can
// contain a dot (isPlainID), so the split is unambiguous.
func projectsWithReviewState(sessionID string) []string {
	if !isPlainID(sessionID) {
		return nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	entries, err := os.ReadDir(filepath.Join(home, ".twing", "sessions", reviewStateDirName))
	if err != nil {
		return nil
	}
	var out []string
	for _, entry := range entries {
		projectID, session, found := strings.Cut(entry.Name(), ".")
		if found && session == sessionID && isPlainID(projectID) {
			out = append(out, projectID)
		}
	}
	return out
}

// reviewBlockReason is the gate's half: the deny text for the first edit in
// `projectID` after comments this session has not yet paused for, or "" to
// let the edit through. Pausing records the comments, so a retry passes --
// that is what makes the block skippable, and it is the user's to skip: the
// text tells the agent to ask before retrying.
//
// Reads only the local record renderOpenReviews wrote, never the network:
// it runs on the gate's hot path, after the coordinator has already been
// asked everything the edit needs. A record that cannot be read means no
// pause, which is the right direction here -- the same session still got
// the context line, and a gate that denied on an unreadable file would be
// blocking on its own bookkeeping.
func reviewBlockReason(projectID, sessionID string) string {
	state := readReviewState(projectID, sessionID)
	fresh := false
	for _, id := range state.openComments {
		if !state.hasPausedFor(id) {
			fresh = true
			break
		}
	}
	if !fresh {
		return ""
	}
	state.pausedFor = append(state.pausedFor, state.openComments...)
	writeReviewState(projectID, sessionID, state)

	var b strings.Builder
	b.WriteString("twing: before this edit -- reviewers left comments on your design in this repo, and nobody has answered them yet:\n")
	writeReviewLines(&b, state.openDesigns)
	b.WriteString("\nStop and tell your user about these comments, then ask whether they want to look at them first or carry on.\n")
	b.WriteString("  - The comments are for your user to answer and resolve in twing-monitor. Do not answer or resolve them yourself.\n")
	b.WriteString("  - If your user wants to carry on, retry this edit: twing pauses only once for these comments, so it will go through.\n")
	b.WriteString("  - If they want the design changed because of a comment, that is their decision to make first.")
	return b.String()
}

// renderDesignLinkReminder returns the commit-trailer reminder, or nothing
// when it was emitted recently enough and the design set has not changed.
//
// A changed design set always re-emits regardless of the interval: the whole
// value of the reminder is that it names the *right* design, and a link to a
// design the agent has since moved on from is worse than no link at all.
func renderDesignLinkReminder(projectID, sessionID string, links []designLink) []string {
	if len(links) == 0 {
		return nil
	}
	state := readReviewState(projectID, sessionID)
	fingerprint := fingerprintLinks(links)
	if !state.shouldEmitReminder(fingerprint, time.Now()) {
		return nil
	}

	var b strings.Builder
	b.WriteString("twing: when you commit this work, add a trailer linking the commit to its design, so a reviewer reading git log can open the design and comment on it:\n")
	if len(links) == 1 {
		b.WriteString("  ")
		b.WriteString(designTrailerKey)
		b.WriteString(": ")
		b.WriteString(links[0].URL)
		b.WriteString("\n")
	} else {
		// twing deliberately does not pick for the agent: it cannot see the
		// commit (Bash is ungated), so any guess it made would be from
		// information the agent has already superseded.
		b.WriteString("  This session has more than one design open. Use the one this commit implements:\n")
		for _, link := range links {
			b.WriteString("    ")
			b.WriteString(truncateSummary(link.Summary))
			b.WriteString("\n      ")
			b.WriteString(designTrailerKey)
			b.WriteString(": ")
			b.WriteString(link.URL)
			b.WriteString("\n")
		}
	}
	b.WriteString("  The link keeps working after the design closes, which is the normal case -- a design closes at session end and commits often land after that.")

	state.recordReminder(fingerprint, time.Now())
	writeReviewState(projectID, sessionID, state)
	return []string{b.String()}
}

func truncateSummary(summary string) string {
	// Newlines would break the one-line-per-design shape of the notice, and
	// an amended summary always has them.
	flattened := strings.Join(strings.Fields(summary), " ")
	if flattened == "" {
		return "(no summary)"
	}
	return truncateRunes(flattened, 80)
}

// truncateRunes cuts on rune boundaries, not bytes -- a summary is free text
// and cutting mid-rune would emit invalid UTF-8 into the agent's context.
func truncateRunes(s string, max int) string {
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	return string(runes[:max-1]) + "…"
}

// fingerprintLinks identifies a set of designs independently of the order the
// coordinator happened to return them in, so a reordered but unchanged set
// does not read as a change and re-emit.
func fingerprintLinks(links []designLink) string {
	ids := make([]string, 0, len(links))
	for _, link := range links {
		ids = append(ids, link.DesignID)
	}
	sort.Strings(ids)
	sum := sha256.Sum256([]byte(strings.Join(ids, ",")))
	return hex.EncodeToString(sum[:8])
}

// reviewState is this session's record for one project, serialized as a
// handful of lines.
//
// A hand-rolled line format rather than JSON, matching the rest of this
// package's local state: it is read and written by one file, never shared,
// and a malformed line has to degrade to "say it again" rather than to an
// error -- re-emitting a line is harmless, while failing to tell a developer
// about waiting comments is the thing this exists to prevent.
type reviewState struct {
	reminderAt          time.Time
	reminderFingerprint string
	// Comments this session has been told about in context.
	shownComments []string
	// The project's open comments as of the last notice, and the designs
	// they sit on -- replaced wholesale on every notice.
	openComments []string
	openDesigns  []openReviewNotice
	// Comments the gate has already paused an edit for.
	pausedFor []string
}

func containsID(ids []string, id string) bool {
	for _, candidate := range ids {
		if candidate == id {
			return true
		}
	}
	return false
}

func (s *reviewState) hasShownComment(id string) bool { return containsID(s.shownComments, id) }

func (s *reviewState) hasPausedFor(id string) bool { return containsID(s.pausedFor, id) }

func (s *reviewState) recordShownComments(ids []string) {
	s.shownComments = append(s.shownComments, ids...)
}

func (s *reviewState) shouldEmitReminder(fingerprint string, now time.Time) bool {
	if s.reminderFingerprint != fingerprint {
		return true // the design set moved -- always re-point the agent
	}
	return now.Sub(s.reminderAt) >= designLinkReminderInterval
}

func (s *reviewState) recordReminder(fingerprint string, now time.Time) {
	s.reminderAt = now
	s.reminderFingerprint = fingerprint
}

func reviewStatePath(projectID, sessionID string) (string, bool) {
	// Same check as sessionAttemptPath, and same reasoning: a projectId is a
	// sha256 digest and a session id is a uuid, so anything else is a reason
	// to write nothing rather than a value to coerce into a filename.
	if !isPlainID(projectID) || !isPlainID(sessionID) {
		return "", false
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", false
	}
	return filepath.Join(home, ".twing", "sessions", reviewStateDirName, projectID+"."+sessionID), true
}

// readReviewState returns the zero value on any failure. That is the safe
// direction for the context lines: an unreadable record means the reminder
// and the open-comment line are emitted again, which is noise. For the gate
// it means no pause -- see reviewBlockReason for why that is also right.
func readReviewState(projectID, sessionID string) *reviewState {
	state := &reviewState{}
	path, ok := reviewStatePath(projectID, sessionID)
	if !ok {
		return state
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return state
	}
	for _, line := range strings.Split(string(data), "\n") {
		key, value, found := strings.Cut(strings.TrimSpace(line), " ")
		if !found {
			continue
		}
		switch key {
		case "reminder_at":
			if unix, err := strconv.ParseInt(value, 10, 64); err == nil {
				state.reminderAt = time.Unix(unix, 0)
			}
		case "reminder_fingerprint":
			state.reminderFingerprint = value
		case "shown_comment":
			state.shownComments = append(state.shownComments, value)
		case "open_comment":
			state.openComments = append(state.openComments, value)
		case "paused_for":
			state.pausedFor = append(state.pausedFor, value)
		case "open_design":
			// Tab-separated because a summary has spaces in it; the count is
			// all the gate's text needs, so ids are not kept per design.
			parts := strings.SplitN(value, "\t", 4)
			if len(parts) != 4 {
				continue
			}
			count, err := strconv.Atoi(parts[1])
			if err != nil || count < 0 {
				continue
			}
			state.openDesigns = append(state.openDesigns, openReviewNotice{DesignID: parts[0], CommentIDs: make([]string, count), URL: parts[2], DesignSummary: parts[3]})
		}
	}
	return state
}

// writeReviewState is best-effort throughout: a machine that cannot write
// here still gets every context line, just without the de-duplication, and
// without the gate's pause.
func writeReviewState(projectID, sessionID string, state *reviewState) {
	path, ok := reviewStatePath(projectID, sessionID)
	if !ok {
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return
	}
	var b strings.Builder
	if !state.reminderAt.IsZero() {
		fmt.Fprintf(&b, "reminder_at %d\n", state.reminderAt.Unix())
	}
	if state.reminderFingerprint != "" {
		fmt.Fprintf(&b, "reminder_fingerprint %s\n", state.reminderFingerprint)
	}
	for _, id := range state.shownComments {
		fmt.Fprintf(&b, "shown_comment %s\n", id)
	}
	for _, id := range state.openComments {
		fmt.Fprintf(&b, "open_comment %s\n", id)
	}
	for _, id := range state.pausedFor {
		fmt.Fprintf(&b, "paused_for %s\n", id)
	}
	for _, design := range state.openDesigns {
		fmt.Fprintf(&b, "open_design %s\t%d\t%s\t%s\n", design.DesignID, len(design.CommentIDs), design.URL, truncateSummary(design.DesignSummary))
	}
	if err := os.WriteFile(path, []byte(b.String()), 0o600); err != nil {
		return
	}
	pruneReviewState(filepath.Dir(path))
}

// pruneReviewState drops records older than the retention window, mirroring
// pruneSessionAttempts next door.
func pruneReviewState(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	cutoff := time.Now().Add(-reviewStateRetention)
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil || info.ModTime().After(cutoff) {
			continue
		}
		_ = os.Remove(filepath.Join(dir, entry.Name()))
	}
}
