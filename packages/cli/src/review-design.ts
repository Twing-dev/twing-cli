/**
 * `twing review-design` (§6): design/coordination check -- constraint and
 * trigger matches (local), cross-session divergence (server round-trip).
 */

import * as path from "node:path";
import { readConfig, findRepoRoot, computeProjectId, loadManifestFromFile, matchTriggers, type Finding } from "@twing/core";
import { gatherClaims } from "./gather-claims.js";
import { queryDaemonNotices } from "./daemon-client.js";
import { printReport } from "./report.js";

export interface ReviewDesignOptions {
  intent?: string;
  cwd: string;
}

export async function runReviewDesign(options: ReviewDesignOptions): Promise<void> {
  const repoRoot = findRepoRoot(options.cwd);
  const manifest = loadManifestFromFile(path.join(repoRoot, ".twing", "verify.yml"));
  const projectId = computeProjectId(repoRoot);

  const gathered = await gatherClaims(options.cwd);

  // §6: intent is low-confidence, narration-only -- it only narrows which
  // triggers get surfaced when there's not yet a diff to inspect. Never
  // treated as evidence, never suppresses a diff-based finding.
  const intentHits = options.intent ? matchTriggers(manifest, options.intent) : [];

  const serverUrl = readConfig().serverUrl;
  let findings: Finding[] = [];
  let serverError: string | undefined;

  if (serverUrl && (gathered.claims.length > 0 || gathered.callEdges.length > 0)) {
    try {
      const res = await fetch(`${serverUrl}/v1/claims`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, claims: gathered.claims, callEdges: gathered.callEdges }),
      });
      if (res.ok) {
        const body = (await res.json()) as { findings: Finding[] };
        findings = body.findings;
      } else {
        serverError = `server responded ${res.status}`;
      }
    } catch (err) {
      serverError = err instanceof Error ? err.message : String(err);
    }
  }

  // Daemon path only: its background sync may have already discovered a
  // finding that our own POST above won't re-surface (we likely just
  // resubmitted the same claim the daemon already pushed, which the server
  // correctly treats as a no-op rather than a new finding). Only worth
  // checking when our own round-trip came up empty.
  let daemonNotices: string[] | undefined;
  if (gathered.source === "daemon" && findings.length === 0 && gathered.claims.length > 0) {
    const notices = await queryDaemonNotices(gathered.claims[0].sessionId);
    if (notices && notices.length > 0) daemonNotices = notices.map((n) => n.message);
  }

  printReport({ gathered, manifest, intentHits, findings, serverUrl, serverError, daemonNotices });
}
