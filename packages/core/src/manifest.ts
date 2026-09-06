/**
 * `.twing/twing.yml` manifest parser (§3, §10; file renamed from
 * `verify.yml` -- its scope grew beyond verification policy to include
 * `coordinator`, below). `requireHumanReview`/`constraints` are evaluated
 * locally; only the *results* of evaluating them (constraintIds) transit as
 * part of a Claim. `constraints`/`requireHumanReview` text itself is also,
 * separately, uploaded verbatim by `init`'s cold-start seed
 * (`seedConstraints` -> `POST /v1/constraints/seed`) so the §17 design gate
 * has real statement text to enforce and display -- "never uploaded" was
 * true for the advisory/align path but stale for that seeding path, so
 * don't take it as a blanket guarantee. `coordinator` is different in kind
 * from all of the above: it is never uploaded anywhere, it's read purely
 * locally to know where to send everything else.
 *
 * (2026-08-19: dropped a `triggers`/`TriggerRule`/`matchTriggers` section
 * that used to live here -- symbol-name-regex duplicate-work detection,
 * requiring two developers' claims to coincidentally match a
 * pre-anticipated pattern at the same time. Evaluated and removed rather
 * than kept as a weak stopgap: its realistic catch rate was near zero, and
 * an explicit gap is more honest than a mechanism that rarely fires
 * correctly. No replacement yet -- a future ground-truth/semantic-code
 * comparison is a separate, larger initiative.)
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

/** Where this repo's coordinator lives -- not uploaded anywhere (unlike
 * `constraints`/`requireHumanReview`, see the file-level comment above),
 * read purely locally by `init`/`login`/`align`/`design *` and by the Go
 * hook's design-gate path. */
export interface CoordinatorConfig {
  serverUrl?: string;
}

/** Whether this repo's sessions get their conversation captured to local
 * disk (`~/.twing/sessions/<sessionId>.jsonl`, phase 1). Same kind as
 * `coordinator` and not `constraints`: read purely locally, never uploaded
 * anywhere -- nothing about capture transits today, since phase 1 stops at
 * the local file.
 *
 * **Opt-in: absent means disabled.** A repo turns it on with
 * `capture: {enabled: true}` and nothing else does. Capture is a new
 * data-collection behavior, and one that installing an npm package should
 * never start silently on someone's machine -- so the committed manifest,
 * which somebody had to deliberately edit, is the only thing that can
 * consent to it. That the material is local-only and derived from a file
 * Claude Code already wrote to the same disk is a reason the risk is
 * bounded, not a reason to assume agreement. */
export interface CaptureConfig {
  enabled?: boolean;
}

export interface Manifest {
  requireHumanReview: RequireHumanReviewRule[];
  constraints: ConstraintRule[];
  coordinator: CoordinatorConfig;
  capture: CaptureConfig;
}

const EMPTY_MANIFEST: Manifest = { requireHumanReview: [], constraints: [], coordinator: {}, capture: {} };

export function parseManifest(yamlText: string): Manifest {
  const doc = (parseYaml(yamlText) ?? {}) as Record<string, unknown>;
  const coordinator = (doc.coordinator ?? {}) as Record<string, unknown>;
  const capture = (doc.capture ?? {}) as Record<string, unknown>;
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
    coordinator: {
      serverUrl: typeof coordinator.serverUrl === "string" ? coordinator.serverUrl : undefined,
    },
    capture: {
      enabled: typeof capture.enabled === "boolean" ? capture.enabled : undefined,
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

/** The `capture:` switch's one consumer-facing question, so no caller has
 * to re-decide what an absent block means (see `CaptureConfig`: opt-in, so
 * only an explicit `true` enables it). */
export function captureEnabled(manifest: Manifest): boolean {
  return manifest.capture.enabled === true;
}
