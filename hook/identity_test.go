package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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

// The phantom-.git guard, mirroring identity.test.ts's assertions that no
// `.git` is conjured outside a repo and nothing is written into a stray one.
// This port carried the bug those cover until 2026-09-18: readOrCreatePersistedID
// called os.MkdirAll, so a project id minted outside any repository left
// behind a directory that every existsSync(".git") check -- findRepoRoot's
// included -- reads as a repository forever after.

func TestReadOrCreatePersistedID_NeverCreatesTheDirectory(t *testing.T) {
	dir := t.TempDir()
	idPath := filepath.Join(dir, ".git", "twing-project-id")

	id := readOrCreatePersistedID(idPath)

	if id == "" {
		t.Error("an id is still returned for this run, just not persisted")
	}
	if _, err := os.Stat(filepath.Join(dir, ".git")); !os.IsNotExist(err) {
		t.Errorf("conjured a .git directory at %s; it must write into one, never create one", dir)
	}
}

func TestReadOrCreatePersistedID_WritesIntoAnExistingDirectory(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	idPath := filepath.Join(dir, ".git", "twing-project-id")

	first := readOrCreatePersistedID(idPath)
	second := readOrCreatePersistedID(idPath)

	if first != second {
		t.Errorf("id is not stable across calls: %q then %q", first, second)
	}
	data, err := os.ReadFile(idPath)
	if err != nil {
		t.Fatalf("expected the id to be persisted: %v", err)
	}
	if strings.TrimSpace(string(data)) != first {
		t.Errorf("persisted %q, returned %q", strings.TrimSpace(string(data)), first)
	}
}

// `.git` is a *file* in a worktree or submodule checkout. Writing a child
// path into it fails; the id must degrade to ephemeral rather than error.
func TestReadOrCreatePersistedID_ToleratesGitBeingAFile(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".git"), []byte("gitdir: /elsewhere\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	id := readOrCreatePersistedID(filepath.Join(dir, ".git", "twing-project-id"))

	if id == "" {
		t.Error("expected an ephemeral id rather than an empty one")
	}
}

func TestComputeProjectID_NoIDForSomewhereThatIsNotARepo(t *testing.T) {
	dir := t.TempDir()

	if got := computeProjectID(dir); got != "" {
		t.Errorf("minted %q for a directory that is no repository; a perfectly-shaped id for a project that has never existed is what sent the TS side querying a phantom for a month", got)
	}
	if _, err := os.Stat(filepath.Join(dir, ".git")); !os.IsNotExist(err) {
		t.Error("and it must leave no .git behind on the way out")
	}
}

// The half the TS side cannot hit: it takes an already-resolved repo root,
// this takes cwd. A repo with no origin, entered from a subdirectory, used to
// persist its id at <subdir>/.git/twing-project-id -- a phantom nested inside
// a real repo, so the same checkout answered with two different projects
// depending on where the hook happened to fire.
func TestComputeProjectID_NoRemoteFromSubdirUsesTheRepoRoot(t *testing.T) {
	root := t.TempDir()
	if _, ok := gitOutput(root, "init"); !ok {
		t.Skip("git unavailable")
	}
	sub := filepath.Join(root, "packages", "deep")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}

	fromRoot := computeProjectID(root)
	fromSub := computeProjectID(sub)

	if fromRoot == "" || fromSub == "" {
		t.Fatalf("expected a persisted id for a real repo with no origin: %q, %q", fromRoot, fromSub)
	}
	if fromRoot != fromSub {
		t.Errorf("one checkout reported two projects: %q from the root, %q from %s", fromRoot, fromSub, sub)
	}
	if _, err := os.Stat(filepath.Join(sub, ".git")); !os.IsNotExist(err) {
		t.Errorf("conjured a nested .git at %s", sub)
	}
}
