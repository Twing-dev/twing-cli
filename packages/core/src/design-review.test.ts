import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDesignReviewUrl, DESIGN_TRAILER_KEY, DEFAULT_MONITOR_URL } from "./types.js";

/**
 * The shape here is pinned on purpose: it has to match twing-monitor's own
 * `buildShareUrl` (`src/lib/urlState.ts`), which its router parses with
 * `parseUrlState`. The two repositories share no code, so nothing but a test
 * on each side keeps them in step -- twing-monitor's `urlState.test.ts` is
 * the other half.
 */
test("buildDesignReviewUrl: matches twing-monitor's own share-link shape", () => {
  const url = buildDesignReviewUrl("https://monitor.twing.dev", "proj123", "design456");
  assert.equal(url, "https://monitor.twing.dev/?repos=proj123&tab=designs&focus=design456");
});

test("buildDesignReviewUrl: a trailing slash on the monitor URL doesn't double up", () => {
  assert.equal(buildDesignReviewUrl("https://monitor.twing.dev/", "p", "d"), "https://monitor.twing.dev/?repos=p&tab=designs&focus=d");
  assert.equal(buildDesignReviewUrl("https://monitor.twing.dev///", "p", "d"), "https://monitor.twing.dev/?repos=p&tab=designs&focus=d");
});

test("buildDesignReviewUrl: ids are percent-encoded rather than interpolated raw", () => {
  const url = buildDesignReviewUrl("https://m.example", "a b&c", "d=e");
  assert.equal(url, "https://m.example/?repos=a+b%26c&tab=designs&focus=d%3De");
});

/**
 * The no-monitor case is the one that matters operationally. A self-hosted
 * coordinator with no dashboard deployed must produce no link at all --
 * falling back to twing's hosted monitor would send its users somewhere that
 * cannot show them their own designs.
 */
test("buildDesignReviewUrl: no monitor means no link, never a guess at the hosted one", () => {
  assert.equal(buildDesignReviewUrl(undefined, "p", "d"), undefined);
  assert.equal(buildDesignReviewUrl("", "p", "d"), undefined);
  assert.equal(buildDesignReviewUrl("   ", "p", "d"), undefined, "whitespace is not a URL");
});

test("buildDesignReviewUrl: a self-hosted monitor keeps its own origin and path prefix", () => {
  assert.equal(buildDesignReviewUrl("https://twing.internal.example:8443", "p", "d"), "https://twing.internal.example:8443/?repos=p&tab=designs&focus=d");
});

test("DESIGN_TRAILER_KEY is a real Git trailer key, so git and forges parse it for free", () => {
  assert.equal(DESIGN_TRAILER_KEY, "Twing-Design");
  assert.match(`${DESIGN_TRAILER_KEY}: https://example`, /^[A-Za-z][A-Za-z-]*: /);
});

test("DEFAULT_MONITOR_URL points at twing's own dashboard", () => {
  assert.equal(DEFAULT_MONITOR_URL, "https://monitor.twing.dev");
});
