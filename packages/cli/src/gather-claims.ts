/**
 * §6 step 1: ask the daemon for the live claim set if it has data for this
 * repo; otherwise fall back to computing directly from git diff. This
 * fallback is what makes `align`/`review` work with zero
 * daemon and zero hooks installed.
 */

import { findRepoRoot, type Claim, type CallEdge } from "@twing/core";
import { queryDaemonClaims } from "./daemon-client.js";
import { gatherFromDiff } from "./diff-claims.js";

export interface GatheredClaims {
  claims: Claim[];
  callEdges: CallEdge[];
  source: "daemon" | "diff";
  defaultBranch?: string;
  mergeBase?: string;
}

export async function gatherClaims(cwd: string): Promise<GatheredClaims> {
  const fromDaemon = await queryDaemonClaims(cwd);
  if (fromDaemon && fromDaemon.claims.length > 0) {
    return { claims: fromDaemon.claims, callEdges: fromDaemon.callEdges, source: "daemon" };
  }

  const repoRoot = findRepoRoot(cwd);
  const diff = await gatherFromDiff(repoRoot);
  if (diff) {
    return { claims: diff.claims, callEdges: diff.callEdges, source: "diff", defaultBranch: diff.defaultBranch, mergeBase: diff.mergeBase };
  }
  return { claims: [], callEdges: [], source: "diff" };
}
