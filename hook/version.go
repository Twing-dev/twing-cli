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

// compareVersions orders two dotted-numeric version strings (e.g. "0.2.6"),
// returning -1/0/1 for a<b/a==b/a>b. Deliberately not a real semver parser
// (no prerelease/build-metadata handling) -- every version this project
// actually produces is a plain X.Y.Z triplet. ok is false if either string
// doesn't parse as one (e.g. "unknown", the sentinel the server sends for a
// bootstrap-gap client with no version header at all, or "dev", a local
// unstamped build) -- callers fall back to the client-behind message in
// that case, the safer of the two since it's also the overwhelmingly more
// common real scenario.
func compareVersions(a, b string) (result int, ok bool) {
	pa, oka := versionParts(a)
	pb, okb := versionParts(b)
	if !oka || !okb {
		return 0, false
	}
	for i := 0; i < 3; i++ {
		if pa[i] != pb[i] {
			if pa[i] < pb[i] {
				return -1, true
			}
			return 1, true
		}
	}
	return 0, true
}

func versionParts(v string) ([3]int, bool) {
	var parts [3]int
	fields := strings.Split(v, ".")
	if len(fields) != 3 {
		return parts, false
	}
	for i, f := range fields {
		n, err := strconv.Atoi(f)
		if err != nil {
			return parts, false
		}
		parts[i] = n
	}
	return parts, true
}
