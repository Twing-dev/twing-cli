package main

import "testing"

// Same fixture table as packages/core/src/identity.test.ts -- both must
// canonicalize every one of these to the same string, or projectId
// diverges across languages the same way it diverged across SSH/HTTPS
// clones in production (2026-08-11).
var equivalentRemoteForms = []string{
	"git@github.com:Org/Repo.git",
	"https://github.com/Org/Repo.git",
	"https://github.com/Org/Repo",
	"https://github.com/Org/Repo/",
	"ssh://git@github.com/Org/Repo.git",
	"http://github.com/Org/Repo.git",
}

func TestCanonicalizeRemoteURL_EquivalentForms(t *testing.T) {
	want := "github.com/org/repo"
	for _, form := range equivalentRemoteForms {
		got := canonicalizeRemoteURL(form)
		if got != want {
			t.Errorf("canonicalizeRemoteURL(%q) = %q, want %q", form, got, want)
		}
	}
}

func TestCanonicalizeRemoteURL_DifferentReposStayDifferent(t *testing.T) {
	a := canonicalizeRemoteURL("git@github.com:Org/Repo.git")
	b := canonicalizeRemoteURL("git@github.com:Org/OtherRepo.git")
	if a == b {
		t.Errorf("expected different repos to canonicalize differently, both got %q", a)
	}
}

func TestCanonicalizeRemoteURL_SelfHostedSSHWithSubgroup(t *testing.T) {
	got := canonicalizeRemoteURL("git@gitlab.example.com:group/sub/repo.git")
	want := "gitlab.example.com/group/sub/repo"
	if got != want {
		t.Errorf("canonicalizeRemoteURL(...) = %q, want %q", got, want)
	}
}

// §17 design linking (2026-08): generateGroupID is a fresh, unpersisted
// primitive (unlike readOrCreatePersistedID above) -- just confirms it
// produces non-empty, distinct values on successive calls.
func TestGenerateGroupID_ReturnsNonEmptyDistinctValues(t *testing.T) {
	a := generateGroupID()
	b := generateGroupID()
	if a == "" || b == "" {
		t.Fatalf("generateGroupID() returned empty string(s): %q, %q", a, b)
	}
	if a == b {
		t.Errorf("two calls returned the same id %q, want distinct", a)
	}
}
