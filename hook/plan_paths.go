package main

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// Resolving a plan to the repos it actually names.
//
// `ExitPlanMode` carries only `{plan: string}` -- no file list -- so the gate
// has to work out which coordinator(s) a plan belongs to before it can
// register anything. It used to do that by listing cwd's immediate
// subdirectories (`discoverChildCoordinators`) and string-prefix-matching the
// server's extracted paths against each directory *name*.
//
// That failed in two ways, both observed against the real binary:
//
//   - **Nothing found, nothing said.** From a session rooted anywhere that is
//     not itself a twing repo -- a scratch checkout, a notes directory, any
//     parent more than one level up -- the scan returns no candidates and the
//     handler returns having written zero bytes. The design is registered on
//     no coordinator and nothing is logged anywhere. Reproduced on a fully
//     installed machine: this is not a bootstrap problem.
//   - **String prefixes, not paths.** `strings.HasPrefix(p, "auth/")` drops
//     `./auth/x.ts`, drops an absolute path, and drops a path written from
//     inside the repo -- all of which name a real file in a real repo.
//
// So resolve from the plan's own paths instead, upward. Every path a plan
// mentions is resolved against cwd and walked up to the nearest
// `.twing/twing.yml`, which finds repos at any depth, as siblings or children
// or neither. The server's extracted `creates`/`touches` are then partitioned
// through the *same* function, so what gets registered is repo-relative by
// real path arithmetic rather than by string surgery.
//
// One limit is inherent: a path only resolves if it is absolute or written
// relative to cwd. A plan that names `code/auth/x.ts` from a session rooted
// in a sibling directory resolves to nothing, because there is no way to know
// what frame the text was written in. That is a silent allow, and the Edit
// gate still demands a design before anything changes.
//
// The regex below is a heuristic on free text, and deliberately so: the
// authoritative extraction is a server-side LLM call
// (`postDesignExtract`) that cannot run until a coordinator is already
// chosen, which is the very thing being decided here. A plan that names
// nothing resolvable simply yields no candidates -- see
// handleExitPlanModeMultiCandidate for why that is allowed through rather
// than denied.

// planPathPattern matches things that look like a file path with an
// extension: at least one `/`, and a final `.ext` of 1-6 alphanumerics.
//
// Requiring both is what keeps prose out. "and/or" has no extension; "0.2.25"
// has no slash; a bare word has neither. URLs do match the shape, so they are
// excluded separately below rather than by contorting this.
var planPathPattern = regexp.MustCompile(`[A-Za-z0-9_.@~-]*(?:/[A-Za-z0-9_.@~-]+)+\.[A-Za-z0-9]{1,6}`)

// planPathCandidates pulls path-like tokens out of free plan text, in first
// occurrence order and de-duplicated.
func planPathCandidates(plan string) []string {
	var out []string
	seen := map[string]bool{}
	for _, match := range planPathPattern.FindAllString(plan, -1) {
		// A URL has the right shape (slashes plus a dotted tail) but names no
		// file on this machine. Checking the surrounding text for "://" is
		// cheaper and clearer than excluding schemes inside the pattern.
		if strings.Contains(match, "://") {
			continue
		}
		// Trim the tail and head separately: a leading dot is meaningful
		// (`.claude/settings.json`, `./auth/x.ts`) and stripping it both
		// mangles dotfile paths and silently turns a relative path into an
		// absolute one pointing at the filesystem root.
		match = strings.TrimRight(match, ".,;:!?)\"'`")
		match = strings.TrimLeft(match, "(\"'`")
		// `~/...` names a machine path, not a file in a repo under review.
		if match == "" || strings.HasPrefix(match, "~") || seen[match] {
			continue
		}
		seen[match] = true
		out = append(out, match)
	}
	return out
}

// repoForPath resolves one plan-written path to the twing repo containing it.
//
// `raw` is whatever the plan said -- absolute, cwd-relative, or `./`-prefixed
// -- and `rel` comes back relative to the repo root, which is the frame the
// coordinator stores and compares designs in.
//
// Walks the lexical ancestry rather than asking git, for two reasons: a path a
// plan *creates* does not exist yet (only some ancestor does), and this runs
// once per distinct directory rather than once per path, so spawning `git`
// here would turn a 50-file plan into 50 subprocesses.
func repoForPath(cwd, raw string) (repoRoot, serverURL, rel string, ok bool) {
	abs := raw
	if !filepath.IsAbs(abs) {
		abs = filepath.Join(cwd, raw)
	}
	abs = filepath.Clean(abs)

	dir := filepath.Dir(abs)
	for i := 0; i < 64; i++ { // bounded: a symlink cycle must not spin here
		if data, err := os.ReadFile(filepath.Join(dir, ".twing", "twing.yml")); err == nil {
			var parsed twingYAML
			url := ""
			if yaml.Unmarshal(data, &parsed) == nil {
				url = parsed.Coordinator.ServerURL
			}
			if url == "" {
				return "", "", "", false // a twing repo with no coordinator configured
			}
			r, err := filepath.Rel(dir, abs)
			if err != nil || strings.HasPrefix(r, "..") {
				return "", "", "", false
			}
			return dir, url, filepath.ToSlash(r), true
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break // reached the filesystem root
		}
		dir = parent
	}
	return "", "", "", false
}

// discoverPlanCoordinators is the replacement for discoverChildCoordinators:
// the repos a plan actually names, rather than whatever happens to sit one
// level below cwd. Ordered by repo root so a multi-repo plan reports
// deterministically.
func discoverPlanCoordinators(cwd, plan string) []childCoordinator {
	byRoot := map[string]childCoordinator{}
	for _, p := range planPathCandidates(plan) {
		root, url, _, ok := repoForPath(cwd, p)
		if !ok {
			continue
		}
		byRoot[root] = childCoordinator{DirName: filepath.Base(root), ServerURL: url, RepoRoot: root}
	}

	roots := make([]string, 0, len(byRoot))
	for root := range byRoot {
		roots = append(roots, root)
	}
	sort.Strings(roots)

	out := make([]childCoordinator, 0, len(roots))
	for _, root := range roots {
		out = append(out, byRoot[root])
	}
	return out
}

// pathsForRepo partitions extracted paths to one repo, repo-relative.
//
// Replaces filterAndStripPrefix's string comparison: these paths come back
// from the server's extraction in whatever form the plan wrote them, so they
// need the same resolution as everything else rather than a prefix test that
// silently drops `./x`, absolute paths, and anything not written as
// `<repoDir>/...`.
func pathsForRepo(cwd, repoRoot string, paths []string) []string {
	var out []string
	for _, p := range paths {
		root, _, rel, ok := repoForPath(cwd, p)
		if ok && root == repoRoot {
			out = append(out, rel)
		}
	}
	return out
}

// distinctServers is the set of coordinators a plan's repos belong to, in
// first-seen order.
func distinctServers(candidates []childCoordinator) []string {
	var out []string
	seen := map[string]bool{}
	for _, c := range candidates {
		if !seen[c.ServerURL] {
			seen[c.ServerURL] = true
			out = append(out, c.ServerURL)
		}
	}
	return out
}
