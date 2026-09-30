package main

import "strconv"
import "strings"

// version identifies this hook binary for the §17 gate's version-compatibility
// check (design_gate.go's setVersionHeader). Overridden at build time via
// `-ldflags "-X main.version=..."` -- see .github/workflows/release-hook.yml
// (the real release binaries) and install-hook.ts's build-from-source
// fallback (sourced from @twing/cli's own package.json version, since
// that's the npm install that triggered a from-source build). Left as "dev"
// for a plain `go build` with no ldflags, e.g. a contributor's own local
// `go build -o twing-hook .` -- that binary will never match any real
// server version, which is correct: it isn't one.
var version = "dev"

// semver is a parsed MAJOR.MINOR.PATCH[-PRERELEASE] version. Build metadata
// (`+...`) is accepted and ignored, as semver says it must be for ordering.
type semver struct {
	core       [3]int
	prerelease []string // dot-separated identifiers; empty for a release
}

// parseVersion reads a published version, prerelease included
// ("1.3.13-experimental.1"). Until 2026-09-30 only a plain X.Y.Z parsed, and
// the self-update guard treats "doesn't parse" as "not a real version": when
// the coordinator moved to 1.3.13-experimental.1, every machine on 1.3.11
// skipped its update without a word and had every edit denied. ok is false
// only for what genuinely is not a version -- "unknown" (the server's
// sentinel for a client that sent no version header), "dev" (a local
// unstamped build), the empty string.
func parseVersion(v string) (semver, bool) {
	var out semver
	if plus := strings.IndexByte(v, '+'); plus >= 0 {
		v = v[:plus]
	}
	core, pre, hasPre := strings.Cut(v, "-")
	fields := strings.Split(core, ".")
	if len(fields) != 3 {
		return out, false
	}
	for i, f := range fields {
		n, err := strconv.Atoi(f)
		if err != nil || n < 0 || (len(f) > 1 && f[0] == '0') {
			return out, false
		}
		out.core[i] = n
	}
	if hasPre {
		if pre == "" {
			return out, false
		}
		for _, id := range strings.Split(pre, ".") {
			if id == "" || strings.Trim(id, "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-") != "" {
				return out, false
			}
			// SemVer forbids leading zeros in a numeric identifier; rejecting
			// them is also what lets compareIdentifier order by length.
			if isNumericIdentifier(id) && len(id) > 1 && id[0] == '0' {
				return out, false
			}
			out.prerelease = append(out.prerelease, id)
		}
	}
	return out, true
}

// versionParts reports whether v is a published version, returning its
// MAJOR.MINOR.PATCH. Kept for its callers, which only ever asked "is this a
// real version I can act on" -- a prerelease is one.
func versionParts(v string) ([3]int, bool) {
	parsed, ok := parseVersion(v)
	return parsed.core, ok
}

// compareVersions orders two versions by semver precedence, returning
// -1/0/1 for a<b/a==b/a>b: the core numbers first, then a prerelease sorts
// before its release (1.3.13-experimental.1 < 1.3.13), and prerelease
// identifiers compare numerically when both are numeric, lexically
// otherwise, with numeric below alphanumeric. ok is false if either is not a
// version (see parseVersion) -- callers fall back to the client-behind
// message in that case, the safer of the two.
func compareVersions(a, b string) (result int, ok bool) {
	pa, oka := parseVersion(a)
	pb, okb := parseVersion(b)
	if !oka || !okb {
		return 0, false
	}
	for i := 0; i < 3; i++ {
		if pa.core[i] != pb.core[i] {
			if pa.core[i] < pb.core[i] {
				return -1, true
			}
			return 1, true
		}
	}
	return comparePrerelease(pa.prerelease, pb.prerelease), true
}

func comparePrerelease(a, b []string) int {
	switch {
	case len(a) == 0 && len(b) == 0:
		return 0
	case len(a) == 0:
		return 1 // a release outranks any of its prereleases
	case len(b) == 0:
		return -1
	}
	for i := 0; i < len(a) && i < len(b); i++ {
		if c := compareIdentifier(a[i], b[i]); c != 0 {
			return c
		}
	}
	switch {
	case len(a) < len(b):
		return -1
	case len(a) > len(b):
		return 1
	}
	return 0
}

// compareIdentifier orders two prerelease identifiers. "Numeric" means
// digits only -- not whatever strconv.Atoi accepts, which would read "-1"
// (an alphanumeric identifier: it has a hyphen) as minus one, and would fail
// on a digit run longer than an int. Numeric identifiers carry no leading
// zeros (parseVersion rejects them), so comparing by length and then
// lexically is numeric order at any size.
func compareIdentifier(a, b string) int {
	numA, numB := isNumericIdentifier(a), isNumericIdentifier(b)
	switch {
	case numA && numB:
		if len(a) != len(b) {
			if len(a) < len(b) {
				return -1
			}
			return 1
		}
		return strings.Compare(a, b)
	case numA:
		return -1 // numeric identifiers sort below alphanumeric ones
	case numB:
		return 1
	}
	return strings.Compare(a, b)
}

func isNumericIdentifier(id string) bool {
	if id == "" {
		return false
	}
	for _, r := range id {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
