/**
 * Cross-session design divergence (statefulness redesign, 2026-08) -- the
 * first place §4 (real, Tree-sitter-derived `Claim`s) and §17 (self-reported
 * `DesignStatement`s) intentionally share logic, not just a data-model
 * family. Before this, `design-checks.ts`'s overlap detection only ever
 * compared two designs' self-reported `creates`/`touches` against each
 * other -- a session's *actual* edits were never checked against what
 * another session's open design claims to own, so two agents could each
 * register honest, non-overlapping designs and then silently drift into
 * each other's territory with nothing noticing.
 *
 * This module's `Finding`s are one of the three real-edit sources
 * (alongside `checks.ts`'s `textual_overlap`/`contract_divergence`) that
 * `app.ts`'s `POST /v1/claims` turns into a `"symbol_conflict"` block
 * (2026-08-26 terminology simplification -- see `DesignVerdict`'s doc
 * comment in core/types.ts). This module itself stays purely a detector --
 * it still just returns `Finding`s and the matched `design`, same shape as
 * before; the flagging/blocking decision lives entirely in `app.ts`, which
 * is also what makes it self-approvable rather than admin-gated: no third
 * party's rule is being overridden here, just a peer's declared scope.
 */

import { minimatch } from "minimatch";
import type { Claim, DesignStatement, Finding } from "@twing/core";

function filePathOf(symbolId: string): string {
  const idx = symbolId.indexOf("::");
  return idx === -1 ? symbolId : symbolId.slice(0, idx);
}

/** True if `claim` falls inside `design`'s declared scope -- checked against
 * both the claim's file path and its full symbolId, against both
 * `creates` and `touches`, the same "literal match or glob" approach
 * `design-checks.ts`'s `matchConstraintsForPaths` uses for constraint
 * scopes (kept as a separate, small function here rather than imported --
 * a real Claim vs. a self-reported design is a different concern from that
 * file's documented two-designs/constraint scope). */
function claimFallsInsideDesign(claim: Claim, design: DesignStatement): boolean {
  const filePath = filePathOf(claim.symbolId);
  const targets = [...design.creates, ...design.touches];
  return targets.some((t) => t === filePath || t === claim.symbolId || minimatch(filePath, t) || minimatch(claim.symbolId, t));
}

function divergenceReason(claim: Claim, design: DesignStatement): string {
  return (
    `twing design coordinator: ${claim.symbolId} was just edited by developer ${claim.developerId}, which falls inside ` +
    `developer ${design.developerId}'s open design (session ${design.sessionId}): "${design.summary || "(no summary)"}". ` +
    `Worth aligning -- see \`twing align threads\` to reply.`
  );
}

export interface DesignDivergenceMatch {
  finding: Finding;
  design: DesignStatement;
}

/** For each new/changed claim, checks every currently-open design from a
 * *different session and a different developer* for scope overlap. One
 * match per (claim, design) pair. Returns the matched `design` alongside
 * its `Finding` -- `app.ts` needs it to open/reuse the right
 * `alignment_threads` row; `runDesignDivergenceChecks` below is the
 * plain-`Finding[]` convenience wrapper for callers (and tests) that don't
 * need that.
 *
 * Previously excluded only `sessionId`, deliberately matching `checks.ts`'s
 * convention of also catching one developer's own two concurrent sessions.
 * Reversed 2026-08-22, same day and same reasoning as `checks.ts`'s own
 * reversal: a usability pass on twing-monitor found same-developer
 * divergence signal was pure feed noise in practice, never once acted on
 * (this project's own history: 14/14 self-pair alignment threads sat open,
 * unreplied). See design-checks.ts's top-of-file comment for the fuller
 * writeup spanning all four layers this touched. */
export function findDesignDivergences(newClaims: Claim[], openDesigns: DesignStatement[]): DesignDivergenceMatch[] {
  const matches: DesignDivergenceMatch[] = [];
  for (const claim of newClaims) {
    // 2026-08-23: skip claims with no resolved symbol -- a bare file path
    // (no "::"), which `claims.ts::extractClaim` still constructs and
    // returns for a whole-file `Write`, an unparseable file (Tree-sitter is
    // JS/TS-only in v0), or a failed edit-point lookup. These carry no more
    // precision than "this file was touched somehow" and were a confirmed,
    // live contributor to alignment-thread noise (several of the 14 threads
    // one design pair accumulated -- see alignment-store.ts's findOrCreate
    // doc comment -- were bare paths, including a `.md` file Tree-sitter
    // can't even parse). Symbol-level claims are unaffected.
    if (!claim.symbolId.includes("::")) continue;
    for (const design of openDesigns) {
      if (design.sessionId === claim.sessionId || design.developerId === claim.developerId) continue;
      if (!claimFallsInsideDesign(claim, design)) continue;
      matches.push({
        design,
        finding: {
          kind: "design_divergence",
          projectId: claim.projectId,
          symbolId: claim.symbolId,
          developerId: claim.developerId,
          otherDeveloperId: design.developerId,
          reason: divergenceReason(claim, design),
          ts: claim.ts,
        },
      });
    }
  }
  return matches;
}

export function runDesignDivergenceChecks(newClaims: Claim[], openDesigns: DesignStatement[]): Finding[] {
  return findDesignDivergences(newClaims, openDesigns).map((m) => m.finding);
}
