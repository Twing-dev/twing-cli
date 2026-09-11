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
 * locally to know where to send everything else. `settings` (2026-09-11) is
 * a third kind again -- uploaded by that same seed and then acted on only
 * by the coordinator, never locally; see `SettingsConfig` below.
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
import { MAX_DESIGN_ACTIVE_TTL_MS, MIN_DESIGN_ACTIVE_TTL_MS } from "./types.js";
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

/** Project-level knobs a repo's admins can tune (2026-09-11), as opposed
 * to the rules (`constraints`/`require_human_review`) and the wiring
 * (`coordinator`/`capture`) above. Third kind of section in this file, and
 * a third relationship to the coordinator: unlike `coordinator`/`capture`
 * (purely local) and unlike `constraints` (uploaded *and* evaluated
 * locally), a setting is uploaded and then enforced **only** server-side --
 * `init` seeds it alongside constraints (`POST /v1/constraints/seed`) and
 * nothing on this side ever acts on it again. That's deliberate: the Go
 * hook registers most designs (`ExitPlanMode`) and is held to reading
 * nothing and deciding nothing (§4), so a setting every registration path
 * would have to parse and send itself would mean teaching it to. Seeding
 * also makes "admin" mean something enforceable -- the seed route requires
 * project `admin` role on an already-founded project, so changing a
 * setting in a committed file that nobody with admin ever seeds does
 * nothing, exactly like a constraint nobody seeded.
 *
 * Values are kept here as the literal strings the file contained; the
 * accessors below are what interpret and range-check them, so an
 * unparseable value is distinguishable from an absent one at the one call
 * site that cares (`init`, which warns) rather than silently identical. */
export interface SettingsConfig {
  /** How long a design can go with no activity before the coordinator
   * demotes it to `dormant` -- a duration string (`"7d"`, `"36h"`,
   * `"90m"`). Absent means `DEFAULT_DESIGN_ACTIVE_TTL_MS`. */
  designDormantAfter?: string;
}

export interface Manifest {
  requireHumanReview: RequireHumanReviewRule[];
  constraints: ConstraintRule[];
  coordinator: CoordinatorConfig;
  capture: CaptureConfig;
  settings: SettingsConfig;
}

const EMPTY_MANIFEST: Manifest = { requireHumanReview: [], constraints: [], coordinator: {}, capture: {}, settings: {} };

export function parseManifest(yamlText: string): Manifest {
  const doc = (parseYaml(yamlText) ?? {}) as Record<string, unknown>;
  const coordinator = (doc.coordinator ?? {}) as Record<string, unknown>;
  const capture = (doc.capture ?? {}) as Record<string, unknown>;
  const settings = (doc.settings ?? {}) as Record<string, unknown>;
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
    settings: {
      // A YAML scalar like `designDormantAfter: 7d` parses as a string
      // already; one written unquoted as a bare number (`7`) parses as a
      // number and is kept verbatim as its text, so the accessor below
      // gets to reject it for having no unit rather than this parser
      // silently guessing which unit was meant.
      designDormantAfter:
        typeof settings.designDormantAfter === "string"
          ? settings.designDormantAfter
          : typeof settings.designDormantAfter === "number"
            ? String(settings.designDormantAfter)
            : undefined,
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

/**
 * Parses a `settings:` duration string -- an integer and a unit suffix,
 * `s`/`m`/`h`/`d` (`"90m"`, `"36h"`, `"7d"`). Returns `undefined` for
 * anything else, the unit-less `"7"` included: this file has exactly one
 * duration setting today and getting its unit wrong by an order of
 * magnitude is the realistic mistake, so requiring the unit is worth more
 * than accepting a convenient shorthand.
 */
export function parseDuration(raw: string): number | undefined {
  const match = /^\s*(\d+)\s*(s|m|h|d)\s*$/.exec(raw);
  if (!match) return undefined;
  const value = Number(match[1]);
  const unitMs = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 }[match[2] as "s" | "m" | "h" | "d"];
  const ms = value * unitMs;
  return Number.isSafeInteger(ms) ? ms : undefined;
}

/**
 * This repo's `settings: designDormantAfter` as milliseconds, or
 * `undefined` when it's absent, unparseable, or outside
 * `MIN_DESIGN_ACTIVE_TTL_MS`..`MAX_DESIGN_ACTIVE_TTL_MS` -- all three
 * collapse to "this project has no override," which leaves
 * `DEFAULT_DESIGN_ACTIVE_TTL_MS` in force. Out of range is refused, never
 * clamped (see those constants' own comment): an admin who wrote `365d`
 * should find out it didn't take, not quietly get 90.
 *
 * Callers that can tell the user something (`init`) should check
 * `manifest.settings.designDormantAfter` themselves for a present-but-
 * rejected value and say so -- from here the two are indistinguishable on
 * purpose, since the daemon and the hook load this file constantly and
 * neither has anywhere useful to put a complaint.
 */
export function designActiveTtlMs(manifest: Manifest): number | undefined {
  const raw = manifest.settings.designDormantAfter;
  if (raw === undefined) return undefined;
  const ms = parseDuration(raw);
  if (ms === undefined || ms < MIN_DESIGN_ACTIVE_TTL_MS || ms > MAX_DESIGN_ACTIVE_TTL_MS) return undefined;
  return ms;
}

/** The `capture:` switch's one consumer-facing question, so no caller has
 * to re-decide what an absent block means (see `CaptureConfig`: opt-in, so
 * only an explicit `true` enables it). */
export function captureEnabled(manifest: Manifest): boolean {
  return manifest.capture.enabled === true;
}
