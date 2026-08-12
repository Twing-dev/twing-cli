/**
 * `.twing/twing.yml` manifest parser (§3, §10; file renamed from
 * `verify.yml` -- its scope grew beyond verification policy to include
 * `coordinator`, below). `requireHumanReview`/`constraints`/`triggers` are
 * evaluated locally; only the *results* of evaluating them (constraintIds,
 * triggerMatches) transit as part of a Claim. `constraints`/
 * `requireHumanReview` text itself is also, separately, uploaded verbatim
 * by `init`'s cold-start seed (`seedConstraints` -> `POST
 * /v1/constraints/seed`) so the §17 design gate has real statement text to
 * enforce and display -- "never uploaded" was true for the advisory/align
 * path but stale for that seeding path, so don't take it as a blanket
 * guarantee. `coordinator` is different in kind from all of the above: it
 * is never uploaded anywhere, it's read purely locally to know where to
 * send everything else.
 */

import { parse as parseYaml, parseDocument, Document } from "yaml";
import { minimatch } from "minimatch";
import * as fs from "node:fs";
import * as path from "node:path";

/** `.twing/twing.yml`, resolved relative to a repo root -- the one place
 * this filename is spelled out, so every caller stays in sync. */
export function twingConfigPath(repoRoot: string): string {
  return path.join(repoRoot, ".twing", "twing.yml");
}

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

/** Where this repo's coordinator lives -- not uploaded anywhere (unlike
 * `constraints`/`requireHumanReview`, see the file-level comment above),
 * read purely locally by `init`/`login`/`align`/`design *` and by the Go
 * hook's design-gate path. */
export interface CoordinatorConfig {
  serverUrl?: string;
}

export interface Manifest {
  requireHumanReview: RequireHumanReviewRule[];
  constraints: ConstraintRule[];
  triggers: TriggerRule[];
  coordinator: CoordinatorConfig;
}

const EMPTY_MANIFEST: Manifest = { requireHumanReview: [], constraints: [], triggers: [], coordinator: {} };

export function parseManifest(yamlText: string): Manifest {
  const doc = (parseYaml(yamlText) ?? {}) as Record<string, unknown>;
  const coordinator = (doc.coordinator ?? {}) as Record<string, unknown>;
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
    coordinator: {
      serverUrl: typeof coordinator.serverUrl === "string" ? coordinator.serverUrl : undefined,
    },
  };
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

/** Returns the empty manifest (never null) when the file doesn't exist —
 * `.twing/twing.yml` is optional, absence is a valid, common state. */
export function loadManifestFromFile(path: string): Manifest {
  if (!fs.existsSync(path)) return EMPTY_MANIFEST;
  return parseManifest(fs.readFileSync(path, "utf8"));
}

export interface UpsertCoordinatorResult {
  written: boolean;
  /** Set when the file already declares a *different* serverUrl -- the
   * write was refused rather than clobbering a team's shared value. */
  conflictingExisting?: string;
}

/**
 * Bootstraps or updates `coordinator.serverUrl` in `.twing/twing.yml`,
 * preserving every other section's content/comments/formatting exactly
 * (`yaml.parseDocument`, not parse+stringify, which would flatten
 * comments). Creates the file if it doesn't exist yet. Refuses to silently
 * overwrite an already-committed *different* value -- callers (`init`) are
 * expected to warn and leave the file untouched on conflict rather than
 * repoint a whole team's coordinator without an explicit, deliberate edit.
 */
export function upsertCoordinatorServerUrl(filePath: string, serverUrl: string): UpsertCoordinatorResult {
  const exists = fs.existsSync(filePath);
  const doc = exists ? parseDocument(fs.readFileSync(filePath, "utf8")) : new Document({});

  const existing = doc.getIn(["coordinator", "serverUrl"]);
  if (typeof existing === "string" && existing !== serverUrl) {
    return { written: false, conflictingExisting: existing };
  }
  if (existing === serverUrl) {
    return { written: false }; // already correct -- nothing to do
  }

  doc.setIn(["coordinator", "serverUrl"], serverUrl);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, doc.toString());
  return { written: true };
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

/** §10: "always flagged in review's output, regardless of what the
 * automated checks conclude." Not wired into the daemon's capture pipeline —
 * this is consumed later by `review` directly against a diff. */
export function matchRequireHumanReview(manifest: Manifest, relPath: string, symbolId: string): string[] {
  const reasons: string[] = [];
  for (const rule of manifest.requireHumanReview) {
    if (rule.path && minimatch(relPath, rule.path)) reasons.push(rule.reason);
    else if (rule.symbol && rule.symbol === symbolId) reasons.push(rule.reason);
  }
  return reasons;
}
