package main

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
