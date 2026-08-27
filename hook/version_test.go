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
