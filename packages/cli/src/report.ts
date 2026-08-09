/**
 * §6 step 4: "Print a combined, ranked report — local constraint/trigger
 * hits first (cheapest, most certain), then server-side divergence
 * findings, each with the symbol, the other party involved (if any), and
 * why it was flagged."
 */

import type { Claim, Finding, Manifest, TriggerMatch } from "@twing/core";
import type { GatheredClaims } from "./gather-claims.js";

export interface ReportInput {
  gathered: GatheredClaims;
  manifest: Manifest;
  intentHits: TriggerMatch[];
  findings: Finding[];
  serverUrl?: string;
  serverError?: string;
  /** Findings the daemon's background sync already discovered, already
   * reduced to flat messages (§7's Notice shape) -- shown only when our own
   * round-trip above came up empty, since that's the specific gap they
   * cover: an unchanged resubmission the server correctly treats as a
   * no-op rather than a fresh finding. */
  daemonNotices?: string[];
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}

function constraintText(manifest: Manifest, id: string): string {
  const index = Number(id.split(":")[1]);
  return manifest.constraints[index]?.text ?? id;
}

function triggerReason(manifest: Manifest, id: string): string {
  return manifest.triggers.find((t) => t.id === id)?.reason ?? id;
}

function claimSourceLine(gathered: GatheredClaims): string {
  const n = gathered.claims.length;
  if (gathered.source === "daemon") {
    return `claims: live session data from the daemon (${n} claim${plural(n)})`;
  }
  if (gathered.defaultBranch) {
    return `claims: no daemon running -- computed from git diff against ${gathered.mergeBase?.slice(0, 8)} (merge-base with ${gathered.defaultBranch}), ${n} claim${plural(n)}`;
  }
  return "claims: no daemon running and no default branch found (no origin/HEAD, no local main or master) -- nothing to compute";
}

export function printReport(input: ReportInput): void {
  const { gathered, manifest, intentHits, findings, serverUrl, serverError, daemonNotices } = input;

  console.log("twing align");
  console.log(claimSourceLine(gathered));
  console.log("");

  const constraintHits: { claim: Claim; id: string }[] = [];
  const triggerHits: { claim: Claim; id: string }[] = [];
  for (const claim of gathered.claims) {
    for (const id of claim.constraintIds ?? []) constraintHits.push({ claim, id });
    for (const id of claim.triggerMatches ?? []) triggerHits.push({ claim, id });
  }

  const localCount = constraintHits.length + triggerHits.length;
  console.log(`Local checks (${localCount} hit${plural(localCount)}):`);
  if (localCount === 0) {
    console.log("  none");
  }
  for (const { claim, id } of constraintHits) {
    console.log(`  [constraint] ${claim.symbolId}`);
    console.log(`    ${constraintText(manifest, id)}`);
  }
  for (const { claim, id } of triggerHits) {
    console.log(`  [trigger: ${id}] ${claim.symbolId} (new symbol)`);
    console.log(`    ${triggerReason(manifest, id)}`);
  }
  console.log("");

  console.log(`Cross-session findings (${findings.length}):`);
  if (!serverUrl) {
    console.log("  skipped -- no server configured (run `twing init --server <url>`)");
  } else if (serverError) {
    console.log(`  skipped -- ${serverError}`);
  } else if (findings.length === 0 && daemonNotices?.length) {
    console.log("  from the daemon's own background sync (already discovered, not new from this run):");
    for (const message of daemonNotices) {
      console.log(`  - ${message}`);
    }
  } else if (findings.length === 0) {
    console.log("  none");
  } else {
    for (const f of findings) {
      console.log(`  [${f.kind}] ${f.symbolId} -- other developer: ${f.otherDeveloperId}`);
      console.log(`    ${f.reason}`);
    }
  }

  if (intentHits.length > 0) {
    console.log("");
    console.log(`Intent-matched triggers (narration-only, not evidence -- ${intentHits.length}):`);
    for (const hit of intentHits) {
      console.log(`  [${hit.triggerId}] ${hit.reason}`);
    }
  }
}
