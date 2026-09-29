package main

import (
	"strings"
	"testing"
	"time"
)

// These cover the behaviours design_review.go exists for: open review comments
// reach the agent once per session (and, for the repo being edited, pause one
// edit so the agent tells its user), and the commit-trailer reminder repeats
// often enough not to be forgotten but rarely enough not to be ignored.

const testProject = "a1b2c3"
const otherProject = "d4e5f6"

func sampleReview(projectID string, commentIDs ...string) openReviewNotice {
	return openReviewNotice{
		DesignID:      "design-1",
		ProjectID:     projectID,
		DesignSummary: "Add a retry budget to the HTTP client",
		CommentIDs:    commentIDs,
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

func TestRenderOpenReviews_NamesTheDesignTheCountAndWhereToAnswer(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	messages := renderOpenReviews(testProject, "session-one", []openReviewNotice{sampleReview(testProject, "c1", "c2")})
	if len(messages) != 1 {
		t.Fatalf("want 1 message, got %d", len(messages))
	}
	for _, want := range []string{
		"Add a retry budget",
		"2 open comments",
		"https://monitor.twing.dev/?repos=p&tab=designs&focus=design-1",
		"not for you to act on",
		// The agent is told the pause is coming, so it is not a surprise.
		"pause the next edit in this repo once",
	} {
		if !strings.Contains(messages[0], want) {
			t.Errorf("notice missing %q:\n%s", want, messages[0])
		}
	}
}

// A repo the session is not in gets a mention and nothing else -- the agent
// there has no code to act on and nothing to pause.
func TestRenderOpenReviews_OtherReposAreAMentionWithNoPause(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	messages := renderOpenReviews(testProject, "session-one", []openReviewNotice{sampleReview(otherProject, "c1")})
	if len(messages) != 1 {
		t.Fatalf("want 1 message, got %d", len(messages))
	}
	if !strings.Contains(messages[0], "other repos") || !strings.Contains(messages[0], "1 open comment") {
		t.Errorf("unexpected message:\n%s", messages[0])
	}
	if strings.Contains(messages[0], "pause") {
		t.Errorf("a repo the session is not editing must not promise a pause:\n%s", messages[0])
	}
	if got := reviewBlockReason(testProject, "session-one"); got != "" {
		t.Errorf("an edit in this repo must not be paused for another repo's comments:\n%s", got)
	}
}

func TestRenderOpenReviews_ToldOncePerSessionAndAgainForANewComment(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	first := []openReviewNotice{sampleReview(testProject, "c1")}

	if got := renderOpenReviews(testProject, "session-one", first); len(got) != 1 {
		t.Fatalf("first call: want 1, got %d", len(got))
	}
	if got := renderOpenReviews(testProject, "session-one", first); len(got) != 0 {
		t.Fatalf("second call in the same session: want 0, got %d", len(got))
	}
	if got := renderOpenReviews(testProject, "session-one", []openReviewNotice{sampleReview(testProject, "c1", "c2")}); len(got) != 1 {
		t.Fatalf("a new comment must surface again, got %d", len(got))
	}
	// A different session is told again. What stops it for good is a reviewer
	// resolving the comment, never a local file deciding it was said enough.
	if got := renderOpenReviews(testProject, "session-two", first); len(got) != 1 {
		t.Fatalf("new session: want 1, got %d", len(got))
	}
}

func TestRenderOpenReviews_NothingToSayIsSilent(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if got := renderOpenReviews(testProject, "session-one", nil); got != nil {
		t.Fatalf("want nil, got %v", got)
	}
}

// --- the gate's one-time pause --------------------------------------------

func TestReviewBlockReason_PausesOnceThenLetsTheRetryThrough(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	renderOpenReviews(testProject, "session-one", []openReviewNotice{sampleReview(testProject, "c1")})

	reason := reviewBlockReason(testProject, "session-one")
	if reason == "" {
		t.Fatal("the first edit after an open comment must pause")
	}
	for _, want := range []string{"tell your user", "Do not answer or resolve them yourself", "retry this edit", "focus=design-1"} {
		if !strings.Contains(reason, want) {
			t.Errorf("deny missing %q:\n%s", want, reason)
		}
	}
	if got := reviewBlockReason(testProject, "session-one"); got != "" {
		t.Errorf("the retry must go through -- the pause is skippable:\n%s", got)
	}
}

func TestReviewBlockReason_ANewCommentPausesAgain(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	renderOpenReviews(testProject, "session-one", []openReviewNotice{sampleReview(testProject, "c1")})
	reviewBlockReason(testProject, "session-one")

	renderOpenReviews(testProject, "session-one", []openReviewNotice{sampleReview(testProject, "c1", "c2")})
	if got := reviewBlockReason(testProject, "session-one"); got == "" {
		t.Error("a comment that arrived after the last pause is news, and must pause once")
	}
}

// Resolving is what ends it: a project that drops out of the daemon's answer
// has its record emptied, so the gate never pauses on a comment a reviewer
// already closed.
func TestReviewBlockReason_ResolvedCommentsNeverPause(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	renderOpenReviews(testProject, "session-one", []openReviewNotice{sampleReview(testProject, "c1")})
	renderOpenReviews(testProject, "session-one", nil)

	if got := reviewBlockReason(testProject, "session-one"); got != "" {
		t.Errorf("paused on a resolved comment:\n%s", got)
	}
}

// The gate keys on the repo of the file being edited, which need not be the
// session's cwd. A session standing in one repo and editing another must
// still be paused for the other's comments.
func TestReviewBlockReason_FollowsTheEditedRepoNotTheSessionsCwd(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	renderOpenReviews(testProject, "session-one", []openReviewNotice{sampleReview(otherProject, "c1")})

	if got := reviewBlockReason(otherProject, "session-one"); got == "" {
		t.Error("an edit in the repo with the open comments must pause, whatever the cwd")
	}
}

func TestReviewBlockReason_IsPerSession(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	notices := []openReviewNotice{sampleReview(testProject, "c1")}
	renderOpenReviews(testProject, "session-one", notices)
	renderOpenReviews(testProject, "session-two", notices)
	reviewBlockReason(testProject, "session-one")

	if got := reviewBlockReason(testProject, "session-two"); got == "" {
		t.Error("skipping in one session must not skip for another")
	}
}

func TestReviewBlockReason_NoRecordMeansNoPause(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if got := reviewBlockReason(testProject, "session-one"); got != "" {
		t.Errorf("want no pause without a record, got:\n%s", got)
	}
	if got := reviewBlockReason("../escape", "session-one"); got != "" {
		t.Errorf("an unusable project id must not pause, got:\n%s", got)
	}
}

// --- the commit-trailer reminder ------------------------------------------

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

// --- shared state ---------------------------------------------------------

// An unwritable or unusable state path must degrade to "say it again", never
// to silence: repeating a line is noise, while swallowing open comments loses
// questions a reviewer is waiting on.
func TestReviewState_UnusableIDsDegradeToAlwaysSaying(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	notices := []openReviewNotice{sampleReview(testProject, "c1")}

	if _, ok := reviewStatePath("../escape", "session-one"); ok {
		t.Fatal("a path-traversing project id must not resolve to a file")
	}
	if got := renderOpenReviews("../escape", "session-one", notices); len(got) != 1 {
		t.Fatalf("first call: want 1, got %d", len(got))
	}
	if got := renderOpenReviews("../escape", "session-one", notices); len(got) != 1 {
		t.Fatal("with no usable state file the notice must repeat, not go silent")
	}
}

func TestTruncateSummary_FlattensNewlinesAndCutsOnRuneBoundaries(t *testing.T) {
	if got := truncateSummary("line one\n\nUpdate (2026-09-27): line two"); got != "line one Update (2026-09-27): line two" {
		t.Errorf("an amended summary's newlines would break the one-line-per-design shape, got %q", got)
	}
	if got := truncateSummary("   "); got != "(no summary)" {
		t.Errorf("want (no summary), got %q", got)
	}
	got := truncateSummary(strings.Repeat("é", 400))
	for _, r := range got {
		if r == '\uFFFD' {
			t.Fatal("cutting on bytes rather than runes emitted invalid UTF-8")
		}
	}
	if len([]rune(got)) != 80 {
		t.Errorf("want 80 runes, got %d", len([]rune(got)))
	}
}

// The open-review record round-trips, summary spaces and all -- the gate
// renders its deny from it long after the daemon's answer is gone.
func TestReviewState_OpenDesignsRoundTrip(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	renderOpenReviews(testProject, "session-one", []openReviewNotice{sampleReview(testProject, "c1", "c2")})

	state := readReviewState(testProject, "session-one")
	if len(state.openDesigns) != 1 {
		t.Fatalf("want 1 design, got %d", len(state.openDesigns))
	}
	design := state.openDesigns[0]
	if design.DesignSummary != "Add a retry budget to the HTTP client" || len(design.CommentIDs) != 2 || design.URL == "" {
		t.Errorf("record did not round-trip: %+v", design)
	}
}

// All renderers run in the same hook invocation (handleCacheCheck calls them
// back to back) and all read-modify-write the same per-session file. Each
// re-reads before writing, so none clobbers another's fields -- this pins
// that, because reordering them or hoisting the read would silently
// reintroduce a lost update whose only symptom is a notice repeating forever.
func TestReviewState_RenderersDoNotClobberEachOther(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	notices := []openReviewNotice{sampleReview(testProject, "c1")}
	links := []designLink{sampleLink("design-1")}

	// Same order as handleCacheCheck.
	renderOpenReviews(testProject, "session-one", notices)
	renderDesignLinkReminder(testProject, "session-one", links)

	state := readReviewState(testProject, "session-one")
	if !state.hasShownComment("c1") || len(state.openComments) != 1 {
		t.Error("the reminder write dropped the open-review record")
	}
	if state.reminderFingerprint != fingerprintLinks(links) {
		t.Error("the open-review write dropped the reminder record")
	}

	// And both suppressions still hold on the next invocation.
	if got := renderOpenReviews(testProject, "session-one", notices); len(got) != 0 {
		t.Errorf("open-review notice repeated: %v", got)
	}
	if got := renderDesignLinkReminder(testProject, "session-one", links); len(got) != 0 {
		t.Errorf("reminder repeated: %v", got)
	}
}
