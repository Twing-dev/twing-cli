package main

import "testing"

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b     string
		wantCmp  int
		wantOK   bool
		nameHint string
	}{
		{"0.2.5", "0.2.6", -1, true, "patch behind"},
		{"0.2.6", "0.2.5", 1, true, "patch ahead"},
		{"0.2.6", "0.2.6", 0, true, "equal"},
		{"1.0.0", "0.9.9", 1, true, "major ahead outweighs minor/patch"},
		{"0.2.6", "unknown", 0, false, "bootstrap-gap sentinel doesn't parse"},
		{"dev", "0.2.6", 0, false, "unstamped local build doesn't parse"},
		{"0.2", "0.2.6", 0, false, "missing a component doesn't parse"},
		// Prereleases are real versions (2026-09-30): a coordinator on one
		// must be something every machine can update to and order against.
		{"1.3.11", "1.3.13-experimental.1", -1, true, "a release behind a later prerelease"},
		{"1.3.13-experimental.1", "1.3.13", -1, true, "a prerelease sorts before its release"},
		{"1.3.13", "1.3.13-experimental.1", 1, true, "a release outranks its prerelease"},
		{"1.3.13-experimental.1", "1.3.13-experimental.2", -1, true, "numeric identifiers compare numerically"},
		{"1.3.13-experimental.10", "1.3.13-experimental.2", 1, true, "10 > 2, not lexically"},
		{"1.3.13-1", "1.3.13-alpha", -1, true, "numeric identifiers sort below alphanumeric"},
		{"1.3.13-alpha", "1.3.13-alpha.1", -1, true, "fewer identifiers sort first when the rest are equal"},
		{"1.3.13+build.5", "1.3.13", 0, true, "build metadata is ignored for ordering"},
		{"1.3.13-", "1.3.13", 0, false, "an empty prerelease doesn't parse"},
		{"01.3.13", "1.3.13", 0, false, "a leading zero doesn't parse"},
	}
	for _, c := range cases {
		gotCmp, gotOK := compareVersions(c.a, c.b)
		if gotOK != c.wantOK {
			t.Errorf("%s: compareVersions(%q, %q) ok = %v, want %v", c.nameHint, c.a, c.b, gotOK, c.wantOK)
			continue
		}
		if gotOK && gotCmp != c.wantCmp {
			t.Errorf("%s: compareVersions(%q, %q) = %d, want %d", c.nameHint, c.a, c.b, gotCmp, c.wantCmp)
		}
	}
}
