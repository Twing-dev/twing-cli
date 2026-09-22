package main

import (
	"strings"
	"testing"
	"time"
)

// These cover the two behaviours design_review.go exists for: an escalation
// reaches the agent once per session, and the commit-trailer reminder repeats
// often enough not to be forgotten but rarely enough not to be ignored.

const testProject = "a1b2c3"

func sampleEscalation(commentID string) escalationNotice {
	return escalationNotice{
		CommentID:     commentID,
		DesignID:      "design-1",
		ProjectID:     testProject,
		DesignSummary: "Add a retry budget to the HTTP client",
		Comment:       "why 30s and not 10s?",
		EscalatedBy:   "reviewer@example.com",
		EscalatedAt:   time.Now().Unix(),
		URL:           "https://monitor.twing.dev/?repos=p&tab=designs&focus=design-1",
	}
}

func sampleLink(designID string) designLink {
	return designLink{
		DesignID:  designID,
		ProjectID: testProject,
		Summary:   "Add a retry budget to the HTTP client",
		URL:       "https://monitor.twing.dev/?repos=p&tab=designs&focus=" + designID,
	}
}

func TestRenderEscalations_NamesTheDesignCommentAndTheCommandToReadIt(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	messages := renderEscalations(testProject, "session-one", []escalationNotice{sampleEscalation("c1")})
	if len(messages) != 1 {
		t.Fatalf("want 1 message, got %d", len(messages))
	}
	for _, want := range []string{
		"Add a retry budget",
		"why 30s and not 10s?",
		"https://monitor.twing.dev/?repos=p&tab=designs&focus=design-1",
		// Reading is also acknowledging, so an agent that never runs this
		// keeps seeing the same banner every session -- naming it is what
		// makes the banner stoppable.
		"twing design comments design-1",
	} {
		if !strings.Contains(messages[0], want) {
			t.Errorf("banner missing %q:\n%s", want, messages[0])
		}
	}
}

func TestRenderEscalations_ShownOncePerSession(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	escalations := []escalationNotice{sampleEscalation("c1")}

	if got := renderEscalations(testProject, "session-one", escalations); len(got) != 1 {
		t.Fatalf("first call: want 1, got %d", len(got))
	}
	if got := renderEscalations(testProject, "session-one", escalations); len(got) != 0 {
		t.Fatalf("second call in the same session: want 0, got %d", len(got))
	}
	// A different session surfaces it again. That is the intended cadence:
	// what actually stops an escalation is acknowledging it on the
	// coordinator, never a local file deciding it has been seen enough.
	if got := renderEscalations(testProject, "session-two", escalations); len(got) != 1 {
		t.Fatalf("new session: want 1, got %d", len(got))
	}
}

func TestRenderEscalations_NewCommentStillSurfacesAfterAnEarlierOne(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	renderEscalations(testProject, "session-one", []escalationNotice{sampleEscalation("c1")})
	messages := renderEscalations(testProject, "session-one", []escalationNotice{sampleEscalation("c1"), sampleEscalation("c2")})
	if len(messages) != 1 {
		t.Fatalf("want only the new comment, got %d messages", len(messages))
	}
	if !strings.Contains(messages[0], "why 30s") {
		t.Errorf("unexpected message: %s", messages[0])
	}
}

func TestRenderEscalations_NothingToSayIsSilent(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if got := renderEscalations(testProject, "session-one", nil); got != nil {
		t.Fatalf("want nil, got %v", got)
	}
}

func TestRenderDesignLinkReminder_CarriesTheTrailerAndTheURL(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	messages := renderDesignLinkReminder(testProject, "session-one", []designLink{sampleLink("design-1")})
	if len(messages) != 1 {
		t.Fatalf("want 1 message, got %d", len(messages))
	}
	if !strings.Contains(messages[0], "Twing-Design: https://monitor.twing.dev/?repos=p&tab=designs&focus=design-1") {
		t.Errorf("reminder is not copy-pasteable as a trailer:\n%s", messages[0])
	}
}

// The rate limit is the whole reason this is safe to put on a per-prompt
// message. Without it the reminder appears in every single turn, which is
// exactly how an agent learns to skip it.
func TestRenderDesignLinkReminder_RateLimitedWithinASession(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	links := []designLink{sampleLink("design-1")}

	if got := renderDesignLinkReminder(testProject, "session-one", links); len(got) != 1 {
		t.Fatalf("first call: want 1, got %d", len(got))
	}
	if got := renderDesignLinkReminder(testProject, "session-one", links); len(got) != 0 {
		t.Fatalf("immediately after: want 0, got %d", len(got))
	}
}

func TestRenderDesignLinkReminder_ReEmitsOnceTheIntervalHasPassed(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	links := []designLink{sampleLink("design-1")}
	renderDesignLinkReminder(testProject, "session-one", links)

	// Backdate the record rather than sleeping out a 20-minute interval.
	state := readReviewState(testProject, "session-one")
	state.reminderAt = time.Now().Add(-designLinkReminderInterval - time.Minute)
	writeReviewState(testProject, "session-one", state)

	if got := renderDesignLinkReminder(testProject, "session-one", links); len(got) != 1 {
		t.Fatalf("after the interval: want 1, got %d", len(got))
	}
}

// A link to a design the agent has moved on from is worse than no link, so a
// changed design set always re-emits regardless of how recently it was shown.
func TestRenderDesignLinkReminder_ReEmitsImmediatelyWhenTheDesignSetChanges(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	if got := renderDesignLinkReminder(testProject, "session-one", []designLink{sampleLink("design-1")}); len(got) != 1 {
		t.Fatalf("first call: want 1, got %d", len(got))
	}
	got := renderDesignLinkReminder(testProject, "session-one", []designLink{sampleLink("design-2")})
	if len(got) != 1 {
		t.Fatalf("after the design changed: want 1, got %d", len(got))
	}
	if !strings.Contains(got[0], "focus=design-2") {
		t.Errorf("reminder still points at the old design:\n%s", got[0])
	}
}

func TestFingerprintLinks_IgnoresOrdering(t *testing.T) {
	a := []designLink{sampleLink("design-1"), sampleLink("design-2")}
	b := []designLink{sampleLink("design-2"), sampleLink("design-1")}
	if fingerprintLinks(a) != fingerprintLinks(b) {
		t.Error("a reordered but unchanged design set must not read as a change")
	}
	if fingerprintLinks(a) == fingerprintLinks([]designLink{sampleLink("design-1")}) {
		t.Error("a genuinely different set must read as a change")
	}
}

// twing cannot see `git commit` at all, so it must not guess which design a
// commit implements -- it would be guessing from information the agent has
// already superseded.
func TestRenderDesignLinkReminder_AsksTheAgentToChooseWhenSeveralDesignsAreOpen(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	messages := renderDesignLinkReminder(testProject, "session-one", []designLink{sampleLink("design-1"), sampleLink("design-2")})
	if len(messages) != 1 {
		t.Fatalf("want 1 message, got %d", len(messages))
	}
	if !strings.Contains(messages[0], "more than one design open") {
		t.Errorf("does not ask the agent to choose:\n%s", messages[0])
	}
	if !strings.Contains(messages[0], "focus=design-1") || !strings.Contains(messages[0], "focus=design-2") {
		t.Errorf("does not offer both designs:\n%s", messages[0])
	}
}

func TestRenderDesignLinkReminder_NoLinksIsSilent(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if got := renderDesignLinkReminder(testProject, "session-one", nil); got != nil {
		t.Fatalf("want nil, got %v", got)
	}
}

// An unwritable or unusable state path must degrade to "say it again", never
// to silence: repeating a reminder is noise, while swallowing an escalation
// loses a question a reviewer is waiting on.
func TestReviewState_UnusableIDsDegradeToAlwaysSaying(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	escalations := []escalationNotice{sampleEscalation("c1")}

	if _, ok := reviewStatePath("../escape", "session-one"); ok {
		t.Fatal("a path-traversing project id must not resolve to a file")
	}
	if got := renderEscalations("../escape", "session-one", escalations); len(got) != 1 {
		t.Fatalf("first call: want 1, got %d", len(got))
	}
	if got := renderEscalations("../escape", "session-one", escalations); len(got) != 1 {
		t.Fatal("with no usable state file the banner must repeat, not go silent")
	}
}

func TestTruncateComment_FlattensNewlinesAndCutsOnRuneBoundaries(t *testing.T) {
	if got := truncateComment("line one\nline two"); got != "line one line two" {
		t.Errorf("newlines would break the banner's one-line-per-field shape, got %q", got)
	}
	if got := truncateComment("   "); got != "(empty)" {
		t.Errorf("want (empty), got %q", got)
	}
	long := strings.Repeat("é", 400)
	got := truncateComment(long)
	if !utf8Valid(got) {
		t.Error("cutting on bytes rather than runes emitted invalid UTF-8")
	}
	if len([]rune(got)) != 300 {
		t.Errorf("want 300 runes, got %d", len([]rune(got)))
	}
}

func utf8Valid(s string) bool {
	for _, r := range s {
		if r == '\uFFFD' {
			return false
		}
	}
	return true
}

// Both renderers run in the same hook invocation (handleCacheCheck calls them
// back to back) and both read-modify-write the same per-session file. Each
// re-reads before writing, so neither clobbers the other's field -- this pins
// that, because reordering them or hoisting the read would silently
// reintroduce a lost update whose only symptom is a banner repeating forever.
func TestReviewState_EscalationAndReminderDoNotClobberEachOther(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	escalations := []escalationNotice{sampleEscalation("c1")}
	links := []designLink{sampleLink("design-1")}

	// Same order as handleCacheCheck.
	renderEscalations(testProject, "session-one", escalations)
	renderDesignLinkReminder(testProject, "session-one", links)

	state := readReviewState(testProject, "session-one")
	if !state.hasShownComment("c1") {
		t.Error("the reminder write dropped the escalation record")
	}
	if state.reminderFingerprint != fingerprintLinks(links) {
		t.Error("the escalation write dropped the reminder record")
	}

	// And both suppressions still hold on the next invocation.
	if got := renderEscalations(testProject, "session-one", escalations); len(got) != 0 {
		t.Errorf("escalation repeated: %v", got)
	}
	if got := renderDesignLinkReminder(testProject, "session-one", links); len(got) != 0 {
		t.Errorf("reminder repeated: %v", got)
	}
}
