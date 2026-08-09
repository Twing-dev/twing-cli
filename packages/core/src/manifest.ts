/**
 * `.twing/verify.yml` manifest parser (§3, §10). Committed to the repo,
 * parsed and evaluated entirely locally — never uploaded. Only the
 * *results* of evaluating it (constraintIds, triggerMatches) transit.
 */

import { parse as parseYaml } from "yaml";
import { minimatch } from "minimatch";
import * as fs from "node:fs";

export interface RequireHumanReviewRule {
  path?: string;
  symbol?: string;
  reason: string;
}

export interface ConstraintRule {
  text: string;
  scope: string;
}

export interface TriggerRule {
  id: string;
  pattern: string;
  match: string;
  reason: string;
}

export interface Manifest {
  requireHumanReview: RequireHumanReviewRule[];
  constraints: ConstraintRule[];
  triggers: TriggerRule[];
}

const EMPTY_MANIFEST: Manifest = { requireHumanReview: [], constraints: [], triggers: [] };

export function parseManifest(yamlText: string): Manifest {
  const doc = (parseYaml(yamlText) ?? {}) as Record<string, unknown>;
  return {
    requireHumanReview: asArray(doc.require_human_review).map((r) => ({
      path: r.path as string | undefined,
      symbol: r.symbol as string | undefined,
      reason: String(r.reason ?? ""),
    })),
    constraints: asArray(doc.constraints).map((c) => ({
      text: String(c.text ?? ""),
      scope: String(c.scope ?? ""),
    })),
    triggers: asArray(doc.triggers).map((t) => ({
      id: String(t.id ?? ""),
      pattern: String(t.pattern ?? ""),
      match: String(t.match ?? ""),
      reason: String(t.reason ?? ""),
    })),
  };
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

/** Returns the empty manifest (never null) when the file doesn't exist —
 * `.twing/verify.yml` is optional, absence is a valid, common state. */
export function loadManifestFromFile(path: string): Manifest {
  if (!fs.existsSync(path)) return EMPTY_MANIFEST;
  return parseManifest(fs.readFileSync(path, "utf8"));
}

/**
 * `(?i)pattern` is the doc's own example syntax (§10) for a case-insensitive
 * match — not valid JS RegExp literal syntax, so it's translated here rather
 * than invented ad hoc.
 */
function compileTriggerPattern(pattern: string): RegExp {
  if (pattern.startsWith("(?i)")) {
    return new RegExp(pattern.slice(4), "i");
  }
  return new RegExp(pattern);
}

export interface ConstraintMatch {
  constraintId: string;
  text: string;
}

/** §12: "Path/symbol matches a constraints entry's scope." */
export function matchConstraints(manifest: Manifest, relPath: string): ConstraintMatch[] {
  const hits: ConstraintMatch[] = [];
  manifest.constraints.forEach((constraint, index) => {
    if (minimatch(relPath, constraint.scope)) {
      // No `id:` field on constraints in the manifest format (§10) — index-based
      // id is stable within one evaluation, which is all a Claim's ttl needs.
      hits.push({ constraintId: `constraint:${index}`, text: constraint.text });
    }
  });
  return hits;
}

export interface TriggerMatch {
  triggerId: string;
  reason: string;
}

/**
 * §12: "New symbol matches a triggers pattern." Only meaningful for symbols
 * that didn't exist before this edit — the daemon decides "new" (§5 step 7)
 * by diffing against its last-known parse of the file; this function only
 * does the pattern match itself, against whatever name it's handed.
 */
export function matchTriggers(manifest: Manifest, newSymbolName: string): TriggerMatch[] {
  const hits: TriggerMatch[] = [];
  for (const trigger of manifest.triggers) {
    if (trigger.match !== "new-symbol-name") continue; // v0 supports only this mode (§10)
    if (compileTriggerPattern(trigger.pattern).test(newSymbolName)) {
      hits.push({ triggerId: trigger.id, reason: trigger.reason });
    }
  }
  return hits;
}

/** §10: "always flagged in review-code's output, regardless of what the
 * automated checks conclude." Not wired into the daemon's capture pipeline —
 * this is consumed later by `review-code` directly against a diff. */
export function matchRequireHumanReview(manifest: Manifest, relPath: string, symbolId: string): string[] {
  const reasons: string[] = [];
  for (const rule of manifest.requireHumanReview) {
    if (rule.path && minimatch(relPath, rule.path)) reasons.push(rule.reason);
    else if (rule.symbol && rule.symbol === symbolId) reasons.push(rule.reason);
  }
  return reasons;
}
