/**
 * Overlap detection (design doc §17.4 / spec §6) -- cheapest, highest-
 * precision first: exact overlap, then dependency collision, then
 * constraint match, then a Jaccard summary-similarity fallback that only
 * runs if the first three found nothing.
 */

import { minimatch } from "minimatch";
import type { DesignStatement, DesignConstraint, DesignConflict, DesignVerdict, DesignConstraintType } from "@twing/core";

export interface DesignCheckOutcome {
  verdict: DesignVerdict;
  conflicts: DesignConflict[];
  constraint?: { statement: string; type: DesignConstraintType };
}

const SUMMARY_SIMILARITY_THRESHOLD = 0.5;

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

function intersects(a: string[], b: string[]): string[] {
  const bSet = new Set(b.map(normalize));
  return a.filter((x) => bSet.has(normalize(x)));
}

/** Tier 1: exact `creates`/`touches` intersection. */
function exactOverlap(candidate: DesignStatement, other: DesignStatement): DesignConflict | undefined {
  const createsHit = intersects(candidate.creates, other.creates);
  const touchesHit = intersects(candidate.touches, other.touches);
  if (createsHit.length === 0 && touchesHit.length === 0) return undefined;
  const hit = [...createsHit, ...touchesHit];
  return {
    conflictingDesignId: other.id,
    agentLabel: other.agentLabel,
    overlapKind: createsHit.length > 0 ? "creates" : "touches",
    overlapDetail: `both ${createsHit.length > 0 ? "create" : "touch"} ${hit.join(", ")}`,
    conflictingSummary: other.summary,
  };
}

/** Tier 2: one design creates what the other assumes already exists (either
 * direction) -- catches "two agents each build their own retry helper" even
 * when file paths never literally collide. */
function dependencyCollision(candidate: DesignStatement, other: DesignStatement): DesignConflict | undefined {
  const candidateBuildsWhatOtherAssumes = intersects(candidate.creates, other.dependsOn);
  const otherBuildsWhatCandidateAssumes = intersects(other.creates, candidate.dependsOn);
  const hit = [...candidateBuildsWhatOtherAssumes, ...otherBuildsWhatCandidateAssumes];
  if (hit.length === 0) return undefined;
  return {
    conflictingDesignId: other.id,
    agentLabel: other.agentLabel,
    overlapKind: "depends_on",
    overlapDetail: `one design creates what the other depends on: ${hit.join(", ")}`,
    conflictingSummary: other.summary,
  };
}

export interface ConstraintHit {
  statement: string;
  type: DesignConstraintType;
}

/**
 * The ground-truth version of tier 3: checks bare paths/symbols against
 * constraint scope globs, independent of any DesignStatement. Extracted
 * (2026-08-11, after a live test showed a `review_required` rule on
 * `packages/server/**` never fired because the session's registered design
 * simply never mentioned that path) so the same matching logic can run
 * against the *actual* file a hook is about to edit -- not just whatever a
 * session's self-reported `creates`/`touches` claimed at registration time.
 * See §17.9.
 */
// When several constraints match the same path, `review_required` outranks
// `canonical_abstraction`/`domain_fact` regardless of scope width (a
// sign-off requirement shouldn't get silently masked by a broader
// duplicate-abstraction rule seeded earlier -- found live, 2026-08-11:
// packages/server/** correctly matched, but the earlier, broader
// packages/** "don't invent a second wire format" rule won the race and
// reported instead, which is a misleading reason even though the deny
// itself was still correct).
const CONSTRAINT_TYPE_PRIORITY: Record<DesignConstraintType, number> = {
  review_required: 0,
  canonical_abstraction: 1,
  domain_fact: 2,
};

export function matchConstraintsForPaths(targets: string[], constraints: DesignConstraint[]): ConstraintHit | undefined {
  let best: { constraint: DesignConstraint; scopeLength: number } | undefined;

  for (const constraint of constraints) {
    for (const scopePattern of constraint.scope) {
      if (!targets.some((t) => t === scopePattern || minimatch(t, scopePattern))) continue;

      const isHigherPriority = !best || CONSTRAINT_TYPE_PRIORITY[constraint.type] < CONSTRAINT_TYPE_PRIORITY[best.constraint.type];
      const isMoreSpecificTie =
        best && CONSTRAINT_TYPE_PRIORITY[constraint.type] === CONSTRAINT_TYPE_PRIORITY[best.constraint.type] && scopePattern.length > best.scopeLength;
      if (isHigherPriority || isMoreSpecificTie) {
        best = { constraint, scopeLength: scopePattern.length };
      }
      break; // this constraint already matched -- no need to check its other scope patterns
    }
  }

  return best ? { statement: best.constraint.statement, type: best.constraint.type } : undefined;
}

/** Tier 3: `creates`/`touches` against a constraint's scope globs. */
function constraintMatch(candidate: DesignStatement, constraints: DesignConstraint[]): ConstraintHit | undefined {
  return matchConstraintsForPaths([...candidate.creates, ...candidate.touches], constraints);
}

function keywordSet(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
}

function jaccard(a: string, b: string): number {
  const setA = keywordSet(a);
  const setB = keywordSet(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersectionSize = 0;
  for (const w of setA) if (setB.has(w)) intersectionSize++;
  const unionSize = new Set([...setA, ...setB]).size;
  return intersectionSize / unionSize;
}

/** Tier 4: deliberately weak fallback net, only consulted when 1-3 find
 * nothing (design doc §17.4 / spec §6.4). */
function summarySimilarity(candidate: DesignStatement, other: DesignStatement): DesignConflict | undefined {
  const score = jaccard(candidate.summary, other.summary);
  if (score < SUMMARY_SIMILARITY_THRESHOLD) return undefined;
  return {
    conflictingDesignId: other.id,
    agentLabel: other.agentLabel,
    overlapKind: "touches",
    overlapDetail: `summaries are ${Math.round(score * 100)}% similar by keyword overlap (fallback signal, low confidence)`,
    conflictingSummary: other.summary,
  };
}

export function runDesignChecks(
  candidate: DesignStatement,
  openDesigns: DesignStatement[],
  constraints: DesignConstraint[],
): DesignCheckOutcome {
  const others = openDesigns.filter((d) => d.id !== candidate.id);

  const structuralConflicts: DesignConflict[] = [];
  for (const other of others) {
    const exact = exactOverlap(candidate, other);
    if (exact) {
      structuralConflicts.push(exact);
      continue;
    }
    const dep = dependencyCollision(candidate, other);
    if (dep) structuralConflicts.push(dep);
  }
  if (structuralConflicts.length > 0) {
    return { verdict: "overlap", conflicts: structuralConflicts };
  }

  const constraintHit = constraintMatch(candidate, constraints);
  if (constraintHit) {
    return { verdict: "constraint_flag", conflicts: [], constraint: constraintHit };
  }

  const similarityConflicts: DesignConflict[] = [];
  for (const other of others) {
    const sim = summarySimilarity(candidate, other);
    if (sim) similarityConflicts.push(sim);
  }
  if (similarityConflicts.length > 0) {
    return { verdict: "overlap", conflicts: similarityConflicts };
  }

  return { verdict: "clean", conflicts: [] };
}
