package main

// Design review, rendered into the session (2026-09). Two advisory texts,
// both riding the `additionalContext` the capture path already emits on
// SessionStart and UserPromptSubmit, and neither able to deny anything --
// this file is on the dumb-pipe side of §4, not the gate's.
//
//  1. **Escalations.** A reviewer read a registered design in twing-monitor,
//     the coordinator's first-pass answer did not satisfy them, and they
//     asked for the human who owns the design. That reaches them here, at
//     the start of their next session, without blocking anything.
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

// renderEscalations returns one banner line per escalated comment the agent
// has not already been shown in this session.
//
// Shown once per session rather than once ever: the record is per session, so
// a new session surfaces an unacknowledged escalation again. That is the
// intended cadence -- an escalation stops appearing when the developer (or
// their agent, by running `twing design comments`) acknowledges it on the
// coordinator, never because a local file decided it had been seen enough.
func renderEscalations(projectID, sessionID string, escalations []escalationNotice) []string {
	if len(escalations) == 0 {
		return nil
	}
	seen := readReviewState(projectID, sessionID)
	messages := make([]string, 0, len(escalations))
	shown := make([]string, 0, len(escalations))

	for _, esc := range escalations {
		if seen.hasShownComment(esc.CommentID) {
			continue
		}
		shown = append(shown, esc.CommentID)

		var b strings.Builder
		b.WriteString("twing: a reviewer escalated a comment on your design ")
		b.WriteString(strconv.Quote(truncateSummary(esc.DesignSummary)))
		b.WriteString(" and is waiting on you.\n")
		b.WriteString("  comment: ")
		b.WriteString(truncateComment(esc.Comment))
		b.WriteString("\n")
		if esc.URL != "" {
			b.WriteString("  review: ")
			b.WriteString(esc.URL)
			b.WriteString("\n")
		}
		// Naming the command matters more than it looks: reading the comment
		// is also what acknowledges it, so an agent that never runs this
		// keeps seeing the same banner every session.
		b.WriteString("  read and reply: twing design comments ")
		b.WriteString(esc.DesignID)
		messages = append(messages, b.String())
	}

	if len(shown) > 0 {
		seen.recordShownComments(shown)
		writeReviewState(projectID, sessionID, seen)
	}
	return messages
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
	trimmed := strings.TrimSpace(summary)
	if trimmed == "" {
		return "(no summary)"
	}
	return truncateRunes(trimmed, 80)
}

func truncateComment(comment string) string {
	// Newlines would break the one-line-per-field shape of the banner, and a
	// reviewer's comment is free text that routinely has them.
	flattened := strings.Join(strings.Fields(comment), " ")
	if flattened == "" {
		return "(empty)"
	}
	return truncateRunes(flattened, 300)
}

// truncateRunes cuts on rune boundaries, not bytes -- a comment is free text
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

// reviewState is this session's record, serialized as a handful of lines.
//
// A hand-rolled line format rather than JSON, matching the rest of this
// package's local state: it is read and written by one file, never shared,
// and a malformed line has to degrade to "say it again" rather than to an
// error -- re-emitting a reminder is harmless, while failing to surface an
// escalation is the thing this exists to prevent.
type reviewState struct {
	reminderAt          time.Time
	reminderFingerprint string
	shownComments       []string
}

func (s *reviewState) hasShownComment(id string) bool {
	for _, seen := range s.shownComments {
		if seen == id {
			return true
		}
	}
	return false
}

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
// direction: an unreadable record means the reminder is emitted again and an
// escalation is shown again, which is noise. The other direction would
// silently swallow an escalation a reviewer is waiting on.
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
		}
	}
	return state
}

// writeReviewState is best-effort throughout: a machine that cannot write
// here still gets every banner, just without the de-duplication.
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
