/**
 * Divergence detection — the v0 checks (§12). Runs "against everything
 * currently active in the project" but is invoked per just-submitted claim,
 * which is equivalent in effect: any divergence not touching a new claim
 * would already have been found and reported when its other side first
 * arrived. Row 3 (opposite-direction design) has no tractable deterministic
 * method yet and is explicitly out of scope for v0 (§12).
 */

import type { Claim, CallEdge, Finding } from "@twing/core";

function finding(kind: Finding["kind"], projectId: string, symbolId: string, developerId: string, otherDeveloperId: string, reason: string, ts: number): Finding {
  return { kind, projectId, symbolId, developerId, otherDeveloperId, reason, ts };
}

/** Check 1: another active write claim on the same symbol from a different
 * session and a different developer. Originally (§8) deliberately included
 * a developer's own two concurrent sessions; reversed 2026-08-22 after a
 * twing-monitor usability pass found same-developer overlap signal was pure
 * feed noise, never acted on in practice (checked against this project's
 * own history: 14/14 self-pair alignment threads sat open, unreplied,
 * across every layer that generates one -- this check, design-checks.ts's
 * tiers, design-divergence.ts, and the semantic comparator). See
 * design-checks.ts's top-of-file comment for the full reasoning; a
 * dedicated same-developer-multi-agent-drift feature is deferred, not
 * rebuilt as a quieter variant of this one. */
function textualOverlap(claim: Claim, active: Claim[], now: number): Finding[] {
  if (claim.kind !== "write") return [];
  const findings: Finding[] = [];
  for (const other of active) {
    if (other === claim) continue;
    if (other.symbolId === claim.symbolId && other.kind === "write" && other.sessionId !== claim.sessionId && other.developerId !== claim.developerId) {
      findings.push(
        finding(
          "textual_overlap",
          claim.projectId,
          claim.symbolId,
          claim.developerId,
          other.developerId,
          `Another active session (developer ${other.developerId}) is also writing to ${claim.symbolId}.`,
          now,
        ),
      );
    }
  }
  return findings;
}

/**
 * Check 2: contract divergence. §12's pseudocode triggers only on the
 * signature-changing claim's own submission ("on new claim c where
 * c.signatureChanged"). Implemented in both directions here — also
 * triggering when the *caller* claim arrives after the signature change is
 * already active — so the finding doesn't depend on submission order; the
 * doc's own §7 framing ("developer A learns about a conflict that only
 * became visible when developer B pushed later") requires this either way.
 */
function contractDivergence(claim: Claim, active: Claim[], edges: CallEdge[], now: number): Finding[] {
  const findings: Finding[] = [];

  if (claim.signatureChanged) {
    const callers = edges.filter((e) => e.calleeSymbolId === claim.symbolId).map((e) => e.callerSymbolId);
    for (const caller of callers) {
      const callerClaims = active.filter((a) => a.symbolId === caller && a.developerId !== claim.developerId);
      if (callerClaims.length > 0) {
        findings.push(
          finding(
            "contract_divergence",
            claim.projectId,
            claim.symbolId,
            claim.developerId,
            callerClaims[0].developerId,
            `Signature of ${claim.symbolId} changed; ${caller} (active claim from developer ${callerClaims[0].developerId}) calls it.`,
            now,
          ),
        );
      }
    }
  }

  const callees = edges.filter((e) => e.callerSymbolId === claim.symbolId).map((e) => e.calleeSymbolId);
  for (const callee of callees) {
    const calleeClaims = active.filter((a) => a.symbolId === callee && a.signatureChanged && a.developerId !== claim.developerId);
    if (calleeClaims.length > 0) {
      findings.push(
        finding(
          "contract_divergence",
          claim.projectId,
          callee,
          claim.developerId,
          calleeClaims[0].developerId,
          `${claim.symbolId} calls ${callee}, whose signature changed (developer ${calleeClaims[0].developerId}).`,
          now,
        ),
      );
    }
  }

  return findings;
}

export function runChecks(newClaims: Claim[], active: Claim[], edges: CallEdge[]): Finding[] {
  const now = Date.now();
  const findings: Finding[] = [];
  for (const claim of newClaims) {
    findings.push(...textualOverlap(claim, active, now));
    findings.push(...contractDivergence(claim, active, edges, now));
  }
  return findings;
}
