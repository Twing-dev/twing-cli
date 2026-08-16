/**
 * Labeled evaluation dataset for `design-checks.ts`'s `runDesignChecks`
 * (statefulness/eval work, 2026-08). Proves today's fast/sync tiers
 * correctly catch obvious/mechanical conflicts, correctly stay quiet on
 * genuinely unrelated designs, and documents exactly which non-obvious/
 * semantic conflicts they structurally miss -- the reference standard the
 * future async LLM-based "detailed path" eval (not built yet) will be
 * graded against.
 *
 * Deliberately a plain data module, not a `*.test.ts` file: cleanly
 * `import`able by that future work without pulling in `node:test` or
 * matching the `dist/*.test.js` test glob. `design-eval.test.ts` is the
 * harness that actually runs these through `runDesignChecks` today.
 *
 * `futureLlmExpectation` is the reference label: `obvious_conflict` and
 * `semantic_gap` cases are both "should_flag_as_conflict" (sync already
 * gets the former right; the LLM path's job is to also get the latter
 * right); `disparate` and `known_false_positive` are both
 * "should_stay_clean" (the LLM path's precision must not regress on cases
 * sync is currently right -- or luckily wrong -- about).
 */

import type {
  DesignStatement,
  DesignConstraint,
  DesignVerdict,
  DesignOverlapKind,
  DesignConstraintType,
} from "@twing/core";
import type { ExtractedDesign } from "./design-extract.js";

export function design(overrides: Partial<DesignStatement> = {}): DesignStatement {
  return {
    id: "d1",
    projectId: "p1",
    developerId: "dev1",
    sessionId: "s1",
    status: "open",
    createdAt: Date.now(),
    summary: "does something",
    creates: [],
    touches: [],
    dependsOn: [],
    ttlMs: 60_000,
    scopeVersion: 1,
    justifiedConstraintIds: [],
    lastActivityAt: Date.now(),
    ...overrides,
  };
}

// New -- no equivalent builder exists anywhere yet; same pattern as design().
export function constraint(overrides: Partial<DesignConstraint> = {}): DesignConstraint {
  return {
    id: "c1",
    projectId: "p1",
    type: "canonical_abstraction",
    statement: "constraint statement",
    scope: [],
    source: "seeded",
    createdAt: Date.now(),
    ...overrides,
  };
}

export type EvalBucket = "obvious_conflict" | "disparate" | "semantic_gap" | "known_false_positive";
export type EvalSource = "manual" | "plan_mode";

export type EvalCategory =
  | "exact_overlap_creates"
  | "exact_overlap_touches"
  | "dependency_collision"
  | "constraint_match"
  | "disparate_unrelated"
  | "disparate_borderline_vocabulary"
  | "semantic_no_literal_overlap"
  | "semantic_contract_mismatch"
  | "semantic_stale_assumption"
  | "semantic_competing_canonicalization"
  | "semantic_near_miss_vocabulary"
  | "semantic_divergent_approach"
  | "multi_design_accumulation"
  | "tier4_boilerplate_false_positive";

export interface EvalCase {
  id: string;
  bucket: EvalBucket;
  category: EvalCategory;
  source: EvalSource;
  rationale: string;

  candidate: DesignStatement;
  openDesigns: DesignStatement[];
  constraints?: DesignConstraint[];

  expectedVerdict: DesignVerdict;
  expectedOverlapKind?: DesignOverlapKind;
  expectedConstraintType?: DesignConstraintType;
  /** Only meaningful when two constraints of the *same* type both match --
   * expectedConstraintType alone can't distinguish the winner then. */
  expectedConstraintStatement?: string;
  /** Only set for multi-design cases -- asserts the accumulated conflicts
   * array's length, not just that it's non-empty. */
  expectedConflictCount?: number;

  futureLlmExpectation: "should_flag_as_conflict" | "should_stay_clean";

  /** Present only when source === "plan_mode": provenance for how the
   * candidate's structured fields were produced. */
  planModeProvenance?: PlanModeProvenance;

  /** Present only for the plan_mode-vs-plan_mode cases, where the *other*
   * design was also conceptually produced by a real ExitPlanMode call, not
   * just the candidate. A real field, not a comment (an earlier version of
   * this file put this content in a comment above the openDesigns entry --
   * findable only by reading source, not by reading the data structure;
   * fixed so every plan text in this dataset is actually discoverable).
   * Only ever paired with a case that has exactly one openDesigns entry. */
  otherPlanModeProvenance?: PlanModeProvenance;
}

export interface PlanModeProvenance {
  rawPlanText: string;
  /** Hand-authored, honestly NOT live-verified -- no credentials for
   * either provider (OpenRouter or Bedrock, see llm-client.ts) exist in
   * this environment. Regenerate for real via
   * extractDesign(rawPlanText, {provider, model, apiKey|region}) once
   * real credentials are available, and confirm the result isn't
   * EMPTY_EXTRACTION before replacing this field. */
  simulatedExtraction: ExtractedDesign;
}

export const EVAL_CASES: EvalCase[] = [
  // ---------------------------------------------------------------------
  // obvious_conflict -- sync tiers MUST catch these (real pass/fail)
  // ---------------------------------------------------------------------
  {
    id: "obvious-01-exact-overlap-creates-retrypolicy",
    bucket: "obvious_conflict",
    category: "exact_overlap_creates",
    source: "manual",
    rationale:
      "Two sessions each register a class literally named RetryPolicy -- tier 1's cheapest, highest-precision check. " +
      "This is the mechanical floor: if this case ever fails, tier 1 itself is broken.",
    candidate: design({
      id: "candidate",
      sessionId: "s-payments",
      creates: ["RetryPolicy"],
      touches: ["src/net/retry.ts"],
      summary: "Add exponential backoff retry wrapper for the payments HTTP client",
    }),
    openDesigns: [
      design({
        id: "open-a",
        sessionId: "s-billing",
        agentLabel: "billing-agent",
        creates: ["RetryPolicy"],
        touches: ["src/net/backoff-helper.ts"],
        summary: "Add a reusable retry policy class for outbound calls",
      }),
    ],
    expectedVerdict: "overlap",
    expectedOverlapKind: "creates",
    futureLlmExpectation: "should_flag_as_conflict",
  },
  {
    id: "obvious-02-exact-overlap-touches-retry-ts-planmode",
    bucket: "obvious_conflict",
    category: "exact_overlap_touches",
    source: "plan_mode",
    rationale:
      "A plan-mode session (no structured fields, only prose) gets extracted to touch src/net/retry.ts; a manually-" +
      "registered design already touches the same file for an unrelated reason. Proves tier 1 doesn't care which " +
      "sourcing path produced the fields.",
    candidate: design({
      id: "candidate",
      sessionId: "s-jitter",
      touches: ["src/net/retry.ts", "src/net/retry.test.ts"],
      summary:
        "Add random jitter to the exponential backoff delay in src/net/retry.ts to avoid thundering-herd retries, with a covering unit test.",
    }),
    openDesigns: [
      design({
        id: "open-b",
        sessionId: "s-breaker",
        creates: ["CircuitBreaker"],
        touches: ["src/net/retry.ts"],
        summary: "Add a circuit breaker around retry.ts so it stops retrying after repeated failures and fails fast",
      }),
    ],
    expectedVerdict: "overlap",
    expectedOverlapKind: "touches",
    futureLlmExpectation: "should_flag_as_conflict",
    planModeProvenance: {
      rawPlanText:
        "I'll look at src/net/retry.ts and add jitter to the exponential backoff calculation so concurrent retries " +
        "from different callers don't all wake up at the same moment (thundering herd). Plan: 1. In src/net/retry.ts, " +
        "modify the backoff function to add a random jitter factor (0-20%) to the computed delay. 2. Add a unit test " +
        "in src/net/retry.test.ts covering the jittered range. No new files, no new public API -- purely an internal " +
        "tweak to the existing retry module.",
      simulatedExtraction: {
        creates: [],
        touches: ["src/net/retry.ts", "src/net/retry.test.ts"],
        dependsOn: [],
        summary:
          "Add random jitter to the exponential backoff delay in src/net/retry.ts to avoid thundering-herd retries, with a covering unit test.",
      },
    },
  },
  {
    id: "obvious-03-dependency-collision-invoicevalidator",
    bucket: "obvious_conflict",
    category: "dependency_collision",
    source: "manual",
    rationale:
      "Zero file/creates overlap (src/billing/validator.ts vs src/billing/invoice.ts) -- a tier-1-only checker would " +
      "miss this. Session A assumes InvoiceValidator exists; Session B is about to build it. This is tier 2's entire " +
      "reason to exist.",
    candidate: design({
      id: "candidate",
      sessionId: "s-validator-build",
      creates: ["InvoiceValidator"],
      touches: ["src/billing/validator.ts"],
      summary: "Add an invoice validation helper that checks required fields are present before an invoice can be saved",
    }),
    openDesigns: [
      design({
        id: "open-c",
        sessionId: "s-invoice-flow",
        touches: ["src/billing/invoice.ts"],
        dependsOn: ["InvoiceValidator"],
        summary: "Wire invoice submission to a shared InvoiceValidator that checks required fields before persisting",
      }),
    ],
    expectedVerdict: "overlap",
    expectedOverlapKind: "depends_on",
    futureLlmExpectation: "should_flag_as_conflict",
  },
  {
    id: "obvious-04-constraint-review-required-server-design-files",
    bucket: "obvious_conflict",
    category: "constraint_match",
    source: "manual",
    rationale:
      "Lifted directly from this repo's own dogfooded constraint (packages/server/src/design-*.ts is flagged " +
      "review_required, live). Proves tier 3 fires on a real, currently-active constraint shape, and that unrelated " +
      "open designs (the dark-mode one below) don't interfere with reaching it.",
    candidate: design({
      id: "candidate",
      touches: ["packages/server/src/design-checks.ts"],
      summary: "Tune the Jaccard threshold in the summary-similarity fallback",
    }),
    openDesigns: [
      design({
        id: "open-d",
        touches: ["src/ui/theme.css"],
        summary: "Adjust dark mode contrast ratios",
      }),
    ],
    constraints: [
      constraint({
        id: "constraint-review-required",
        type: "review_required",
        statement:
          "packages/server/**, especially design-*.ts/identity-store.ts -- a bug in the verdict logic blocks real Edit/Write calls across every gated session",
        scope: ["packages/server/src/design-*.ts"],
      }),
    ],
    expectedVerdict: "constraint_flag",
    expectedConstraintType: "review_required",
    futureLlmExpectation: "should_flag_as_conflict",
  },

  // ---------------------------------------------------------------------
  // disparate -- sync tiers MUST stay clean (real pass/fail, false positives)
  // ---------------------------------------------------------------------
  {
    id: "disparate-05-csv-export-vs-rate-limiter-manual",
    bucket: "disparate",
    category: "disparate_unrelated",
    source: "manual",
    rationale: "Floor true-negative: different files, different symbols, near-zero vocabulary overlap.",
    candidate: design({
      id: "candidate",
      creates: ["ExportCsvButton"],
      touches: ["src/ui/export-button.tsx"],
      summary: "Add a CSV export button to the reports page toolbar",
    }),
    openDesigns: [
      design({
        id: "open-rate-limiter",
        creates: ["RateLimiter"],
        touches: ["src/net/rate-limiter.ts"],
        summary: "Add a token-bucket rate limiter for outbound webhook calls",
      }),
    ],
    expectedVerdict: "clean",
    futureLlmExpectation: "should_stay_clean",
  },
  {
    id: "disparate-06-dark-mode-toggle-planmode-vs-rate-limiter",
    bucket: "disparate",
    category: "disparate_unrelated",
    source: "plan_mode",
    rationale:
      "Same true-negative shape as case 5, but the candidate is plan-mode-sourced -- proves noisier, LLM-extracted " +
      "fields don't introduce spurious overlap.",
    candidate: design({
      id: "candidate",
      creates: ["ThemeToggle"],
      touches: ["src/ui/settings/store.ts", "src/ui/app-shell.tsx"],
      summary:
        "Add a dark mode toggle to the settings page, storing the choice in the existing settings store and applying it via a data-theme attribute on the app shell.",
    }),
    openDesigns: [
      design({
        id: "open-rate-limiter",
        creates: ["RateLimiter"],
        touches: ["src/net/rate-limiter.ts"],
        summary: "Add a token-bucket rate limiter for outbound webhook calls",
      }),
    ],
    expectedVerdict: "clean",
    futureLlmExpectation: "should_stay_clean",
    planModeProvenance: {
      rawPlanText:
        "Add a dark mode toggle to the settings page: 1. Add a new ThemeToggle component in " +
        "src/ui/settings/theme-toggle.tsx. 2. Wire it to a theme value in the existing settings store " +
        "(src/ui/settings/store.ts) -- just add a new field, don't restructure the store. 3. Read that value in " +
        "src/ui/app-shell.tsx to set a data-theme attribute on the root element. No backend changes.",
      simulatedExtraction: {
        creates: ["ThemeToggle"],
        touches: ["src/ui/settings/store.ts", "src/ui/app-shell.tsx"],
        dependsOn: [],
        summary:
          "Add a dark mode toggle to the settings page, storing the choice in the existing settings store and applying it via a data-theme attribute on the app shell.",
      },
    },
  },
  {
    id: "disparate-07-borderline-vocabulary-csv-vs-webhook",
    bucket: "disparate",
    category: "disparate_borderline_vocabulary",
    source: "manual",
    rationale:
      "Deliberately shares 'refactor'/'shared'/'reuses'/'add tests'/'edge case' vocabulary while describing genuinely " +
      "unrelated work -- sits close to, but safely under, tier 4's 0.5 threshold. Contrast directly with case 11, " +
      "where near-identical boilerplate phrasing actually crosses the line.",
    candidate: design({
      id: "candidate",
      touches: ["src/ui/export-button.tsx"],
      summary: "Refactor the CSV export toolbar button so it reuses the shared download utility, and add tests for the empty-selection edge case",
    }),
    openDesigns: [
      design({
        id: "open-webhook",
        touches: ["src/net/webhook-worker.ts"],
        summary: "Refactor the outbound webhook delivery worker so it reuses the shared HTTP client with retries, and add tests for the timeout edge case",
      }),
    ],
    expectedVerdict: "clean",
    futureLlmExpectation: "should_stay_clean",
  },

  // ---------------------------------------------------------------------
  // semantic_gap -- sync is EXPECTED to miss these (documentation, not a bug)
  // ---------------------------------------------------------------------
  {
    id: "gap-08-retry-backoff-http-client-vs-worker-manual",
    bucket: "semantic_gap",
    category: "semantic_no_literal_overlap",
    source: "manual",
    rationale:
      "The crown-jewel case, adapted from simulator/scenarios/retry-duplicate.json's own live scenario as a static " +
      "fixture -- two sessions independently add retry/backoff logic to different files, described in disjoint " +
      "vocabulary. Zero literal file/symbol/dependsOn overlap. This is the case the future LLM path is being built " +
      "to catch.",
    candidate: design({
      id: "candidate",
      sessionId: "s-b",
      touches: ["src/queue/worker.ts"],
      summary:
        "Stop worker jobs from failing on the first hiccup: space reattempts apart with a widening pause, bounded to a small number, before logging the failure",
    }),
    openDesigns: [
      design({
        id: "open-e",
        sessionId: "s-a",
        touches: ["src/net/http-client.ts"],
        summary:
          "Smooth out flaky outbound calls in the HTTP client by pacing reattempts with a growing gap between them, bounded to a small number",
      }),
    ],
    expectedVerdict: "clean",
    futureLlmExpectation: "should_flag_as_conflict",
  },
  {
    id: "gap-09-retry-backoff-worker-planmode-paired-with-08",
    bucket: "semantic_gap",
    category: "semantic_no_literal_overlap",
    source: "plan_mode",
    rationale:
      "Same underlying miss as case 8, deliberately paired against the same 'other' design, but the candidate side " +
      "is realistic plan-mode-extracted prose instead of hand-tuned wording -- proves the gap isn't an artifact of " +
      "how this eval's own prose happens to be written.",
    candidate: design({
      id: "candidate",
      sessionId: "s-b-planmode",
      touches: ["src/queue/worker.ts"],
      summary:
        "Make processJob resilient to failures by waiting and reattempting with an increasing delay a handful of times before logging and moving on, without crashing the worker loop.",
    }),
    openDesigns: [
      design({
        id: "open-e",
        sessionId: "s-a",
        touches: ["src/net/http-client.ts"],
        summary:
          "Smooth out flaky outbound calls in the HTTP client by pacing reattempts with a growing gap between them, bounded to a small number",
      }),
    ],
    expectedVerdict: "clean",
    futureLlmExpectation: "should_flag_as_conflict",
    planModeProvenance: {
      rawPlanText:
        "processJob currently throws away failed jobs immediately. I want to make it more resilient: 1. Wrap the job " +
        "execution in processJob (src/queue/worker.ts) so that on failure it waits a bit and tries again, increasing " +
        "the wait each time, up to a handful of attempts. 2. If it still fails after that, log it and move on (don't " +
        "crash the worker loop). Keeping this scoped to worker.ts -- not touching the HTTP client.",
      simulatedExtraction: {
        creates: [],
        touches: ["src/queue/worker.ts"],
        dependsOn: [],
        summary:
          "Make processJob resilient to failures by waiting and reattempting with an increasing delay a handful of times before logging and moving on, without crashing the worker loop.",
      },
    },
  },
  {
    id: "gap-10-contract-mismatch-design-register-idempotency",
    bucket: "semantic_gap",
    category: "semantic_contract_mismatch",
    source: "manual",
    rationale:
      "No file/symbol/dependsOn overlap at all (CLI vs server side of the same feature). But read together, Session " +
      "A's plan explicitly assumes design-register retries are safe/idempotent, and Session B's design explicitly " +
      "states they are not -- a direct contract-level contradiction no syntactic tier represents.",
    candidate: design({
      id: "candidate",
      sessionId: "s-server",
      touches: ["packages/server/src/design-store.ts"],
      summary:
        "The design register handler always inserts a new DesignStatement row per call, so a client retrying after a timeout will end up with two open designs for the same work",
    }),
    openDesigns: [
      design({
        id: "open-f",
        sessionId: "s-cli",
        touches: ["packages/cli/src/auth.ts"],
        summary:
          "Registers designs idempotently -- retrying design register after a client timeout is safe and will not create a duplicate open design",
      }),
    ],
    expectedVerdict: "clean",
    futureLlmExpectation: "should_flag_as_conflict",
  },

  // ---------------------------------------------------------------------
  // known_false_positive -- found empirically while tuning case 7, kept as
  // its own bucket rather than only proving the near-miss
  // ---------------------------------------------------------------------
  {
    id: "bonus-11-known-false-positive-boilerplate-refactor",
    bucket: "known_false_positive",
    category: "tier4_boilerplate_false_positive",
    source: "manual",
    rationale:
      "Near-boilerplate refactor phrasing this generic crosses tier 4's threshold trivially, even though the two " +
      "designs are completely unrelated. design-checks.ts's own comment calls tier 4 a 'deliberately weak/low-" +
      "confidence fallback' -- this case makes that concrete. Recorded as a currently-true false positive: the " +
      "future LLM path's precision must not inherit it.",
    candidate: design({
      id: "candidate",
      touches: ["src/auth/login.ts"],
      summary: "Refactor the auth module to improve error handling and add tests",
    }),
    openDesigns: [
      design({
        id: "open-billing",
        touches: ["src/billing/invoice.ts"],
        summary: "Refactor the billing module to improve error handling and add tests",
      }),
    ],
    expectedVerdict: "overlap",
    futureLlmExpectation: "should_stay_clean",
  },

  // ---------------------------------------------------------------------
  // plan_mode-vs-plan_mode -- both sides sourced from real ExitPlanMode-
  // style prose, not just the candidate. Every earlier plan_mode case
  // paired a plan-mode candidate against a manual "other"; these are the
  // realistic two-concurrent-agents-in-plan-mode shape this system exists
  // for. The "other" side's rawPlanText/extraction lives in
  // otherPlanModeProvenance -- a real, typed, discoverable field, not a
  // comment (an earlier version of this file put it in a comment above the
  // openDesigns entry, findable only by reading source rather than the
  // data structure -- fixed so every plan text in this dataset is actually
  // visible to anyone reading it).
  // ---------------------------------------------------------------------
  {
    id: "obvious-12-planmode-vs-planmode-exact-creates",
    bucket: "obvious_conflict",
    category: "exact_overlap_creates",
    source: "plan_mode",
    rationale:
      "Two sessions, both real ExitPlanMode-style plans, independently converge on the same class name " +
      "(FeatureFlagClient) in different files -- proves tier 1 catches convergent naming even when neither side is " +
      "hand-authored to collide.",
    candidate: design({
      id: "candidate",
      sessionId: "s-onboarding",
      creates: ["FeatureFlagClient"],
      touches: ["src/onboarding/feature-flag-client.ts"],
      summary:
        "Add a FeatureFlagClient helper for the onboarding flow to check a feature flag before showing the new welcome screen, cached briefly.",
    }),
    openDesigns: [
      design({
        id: "open-checkout",
        sessionId: "s-checkout",
        creates: ["FeatureFlagClient"],
        touches: ["src/flags/client.ts"],
        summary: "Add a FeatureFlagClient helper that wraps the flag-check API with caching, wired into checkout to gate the new payment method.",
      }),
    ],
    expectedVerdict: "overlap",
    expectedOverlapKind: "creates",
    futureLlmExpectation: "should_flag_as_conflict",
    otherPlanModeProvenance: {
      rawPlanText:
        "Add a small helper for checking feature flags before enabling new behavior. Plan: 1. Create a new class " +
        "FeatureFlagClient in src/flags/client.ts that wraps our flag-check API with an isEnabled(flagName) method. " +
        "2. Cache results for 60 seconds to avoid hammering the flag service. 3. Wire it into the checkout flow to " +
        "gate the new payment method.",
      simulatedExtraction: {
        creates: ["FeatureFlagClient"],
        touches: ["src/flags/client.ts"],
        dependsOn: [],
        summary: "Add a FeatureFlagClient helper that wraps the flag-check API with caching, wired into checkout to gate the new payment method.",
      },
    },
    planModeProvenance: {
      rawPlanText:
        "The onboarding flow needs to check a feature flag before showing the new welcome screen. Plan: 1. Create " +
        "FeatureFlagClient in src/onboarding/feature-flag-client.ts with an isEnabled(flagName) method backed by the " +
        "flag service, cached briefly. 2. Use it in the onboarding controller to decide whether to show the new screen.",
      simulatedExtraction: {
        creates: ["FeatureFlagClient"],
        touches: ["src/onboarding/feature-flag-client.ts"],
        dependsOn: [],
        summary:
          "Add a FeatureFlagClient helper for the onboarding flow to check a feature flag before showing the new welcome screen, cached briefly.",
      },
    },
  },
  {
    id: "obvious-13-planmode-vs-planmode-dependency-collision",
    bucket: "obvious_conflict",
    category: "dependency_collision",
    source: "plan_mode",
    rationale:
      "Both sides real plan-mode-style prose: one session's plan builds AuditLogger, the unrelated-looking other " +
      "session's plan wires into 'the existing AuditLogger' -- a legitimate but fragile ordering assumption tier 2 " +
      "is built to surface, not necessarily wrong (the agent may justify it), but worth flagging either way.",
    candidate: design({
      id: "candidate",
      sessionId: "s-admin-actions",
      touches: ["src/admin/actions.ts"],
      dependsOn: ["AuditLogger"],
      summary: "Wire admin actions in src/admin/actions.ts to call the existing AuditLogger.record() after each action, for compliance.",
    }),
    openDesigns: [
      design({
        id: "open-audit",
        sessionId: "s-audit-module",
        creates: ["AuditLogger"],
        touches: ["src/audit/logger.ts"],
        summary: "Create an AuditLogger module with a record() method for compliance logging of admin actions.",
      }),
    ],
    expectedVerdict: "overlap",
    expectedOverlapKind: "depends_on",
    futureLlmExpectation: "should_flag_as_conflict",
    otherPlanModeProvenance: {
      rawPlanText:
        "We need a central place to log admin actions for compliance. Plan: 1. Create an AuditLogger module in " +
        "src/audit/logger.ts with a record(actorId, action, target) method that writes structured log lines. 2. No " +
        "callers yet -- this is just the module itself, to be wired in separately.",
      simulatedExtraction: {
        creates: ["AuditLogger"],
        touches: ["src/audit/logger.ts"],
        dependsOn: [],
        summary: "Create an AuditLogger module with a record() method for compliance logging of admin actions.",
      },
    },
    planModeProvenance: {
      rawPlanText:
        "Every admin action (role change, user suspension, etc.) should be recorded for compliance. Plan: 1. In " +
        "src/admin/actions.ts, call the existing AuditLogger.record() after each admin action completes. 2. No new " +
        "logging infrastructure -- just wiring into what already exists.",
      simulatedExtraction: {
        creates: [],
        touches: ["src/admin/actions.ts"],
        dependsOn: ["AuditLogger"],
        summary: "Wire admin actions in src/admin/actions.ts to call the existing AuditLogger.record() after each action, for compliance.",
      },
    },
  },
  {
    id: "disparate-14-planmode-vs-planmode-unrelated",
    bucket: "disparate",
    category: "disparate_unrelated",
    source: "plan_mode",
    rationale: "Both sides real plan-mode-style prose, genuinely unrelated work (editor shortcuts vs. an ops health-check endpoint). Jaccard 0.036.",
    candidate: design({
      id: "candidate",
      touches: ["src/server/routes/health.ts"],
      summary: "Add an unauthenticated GET /healthz endpoint returning uptime/version for load-balancer health checks.",
    }),
    openDesigns: [
      design({
        id: "open-shortcuts",
        creates: ["ShortcutManager"],
        touches: ["src/editor/shortcuts.ts"],
        summary: "Add keyboard shortcuts (save, toggle comment) to the code editor via a new ShortcutManager wired into the keydown handler.",
      }),
    ],
    expectedVerdict: "clean",
    futureLlmExpectation: "should_stay_clean",
    otherPlanModeProvenance: {
      rawPlanText:
        "Add keyboard shortcuts to the code editor: Cmd+S to save, Cmd+/ to toggle comment. Plan: 1. In " +
        "src/editor/shortcuts.ts, register a ShortcutManager that maps key combos to editor commands. 2. Wire " +
        "ShortcutManager into the editor's keydown handler.",
      simulatedExtraction: {
        creates: ["ShortcutManager"],
        touches: ["src/editor/shortcuts.ts"],
        dependsOn: [],
        summary: "Add keyboard shortcuts (save, toggle comment) to the code editor via a new ShortcutManager wired into the keydown handler.",
      },
    },
    planModeProvenance: {
      rawPlanText:
        "Ops wants a simple health-check endpoint for the load balancer. Plan: 1. Add a GET /healthz route in " +
        "src/server/routes/health.ts that returns 200 with basic status info (uptime, version). 2. No auth required " +
        "on this route -- it needs to be reachable by the load balancer without credentials.",
      simulatedExtraction: {
        creates: [],
        touches: ["src/server/routes/health.ts"],
        dependsOn: [],
        summary: "Add an unauthenticated GET /healthz endpoint returning uptime/version for load-balancer health checks.",
      },
    },
  },
  {
    id: "gap-15-planmode-vs-planmode-debounce",
    bucket: "semantic_gap",
    category: "semantic_no_literal_overlap",
    source: "plan_mode",
    rationale:
      "Both sides real plan-mode-style prose: two unrelated-looking components (product search box, user-directory " +
      "filter) each independently get the exact same debounce-and-abort fix. Jaccard 0.094 -- zero literal overlap, " +
      "both plan_mode this time, not paired against a manual case like gap-08/09.",
    candidate: design({
      id: "candidate",
      sessionId: "s-directory-filter",
      touches: ["src/admin/user-directory-filter.tsx"],
      summary:
        "Wait for a pause in typing before running the user-directory filter lookup, aborting in-flight lookups on further keystrokes, to stop flooding the API.",
    }),
    openDesigns: [
      design({
        id: "open-search-box",
        sessionId: "s-search-box",
        touches: ["src/search/product-search-box.tsx"],
        summary: "Delay firing product search requests until typing pauses, cancelling pending requests on further keystrokes, to avoid a request per keystroke.",
      }),
    ],
    expectedVerdict: "clean",
    futureLlmExpectation: "should_flag_as_conflict",
    otherPlanModeProvenance: {
      rawPlanText:
        "The product search box fires a request on every keystroke, which is wasteful. Plan: 1. In " +
        "src/search/product-search-box.tsx, delay firing the search request until the user pauses typing for a bit " +
        "(a few hundred ms), cancelling any pending request if they keep typing. 2. No backend changes.",
      simulatedExtraction: {
        creates: [],
        touches: ["src/search/product-search-box.tsx"],
        dependsOn: [],
        summary: "Delay firing product search requests until typing pauses, cancelling pending requests on further keystrokes, to avoid a request per keystroke.",
      },
    },
    planModeProvenance: {
      rawPlanText:
        "The user directory filter box does a lookup on every character typed, which floods the API. Plan: 1. In " +
        "src/admin/user-directory-filter.tsx, wait for a short pause in typing before running the filter lookup, and " +
        "abort any in-flight lookup if the user types again. 2. Frontend-only change.",
      simulatedExtraction: {
        creates: [],
        touches: ["src/admin/user-directory-filter.tsx"],
        dependsOn: [],
        summary:
          "Wait for a pause in typing before running the user-directory filter lookup, aborting in-flight lookups on further keystrokes, to stop flooding the API.",
      },
    },
  },

  // ---------------------------------------------------------------------
  // constraint coverage -- case 4 only ever exercised review_required;
  // canonical_abstraction/domain_fact never appeared, and neither did the
  // priority/specificity tiebreak logic CONSTRAINT_TYPE_PRIORITY implements.
  // ---------------------------------------------------------------------
  {
    id: "obvious-16-constraint-canonical-abstraction",
    bucket: "obvious_conflict",
    category: "constraint_match",
    source: "manual",
    rationale: "canonical_abstraction has never appeared in this eval -- case 4 only ever exercised review_required.",
    candidate: design({
      id: "candidate",
      touches: ["src/net/http-client-v2.ts"],
      summary: "Add a lighter-weight HTTP client for the reporting service's occasional batch calls",
    }),
    openDesigns: [design({ id: "open-unrelated", touches: ["src/ui/theme.css"], summary: "Adjust dark mode contrast ratios" })],
    constraints: [
      constraint({
        id: "constraint-canonical",
        type: "canonical_abstraction",
        statement: "use the shared HTTP client wrapper in src/net/http-client.ts; don't build a second one",
        scope: ["src/net/**"],
      }),
    ],
    expectedVerdict: "constraint_flag",
    expectedConstraintType: "canonical_abstraction",
    futureLlmExpectation: "should_flag_as_conflict",
  },
  {
    id: "obvious-17-constraint-domain-fact",
    bucket: "obvious_conflict",
    category: "constraint_match",
    source: "manual",
    rationale: "domain_fact has never appeared in this eval either.",
    candidate: design({
      id: "candidate",
      touches: ["src/payments/refund-calculator.ts"],
      summary: "Add a refund calculator that computes partial refund amounts",
    }),
    openDesigns: [design({ id: "open-unrelated", touches: ["src/ui/theme.css"], summary: "Adjust dark mode contrast ratios" })],
    constraints: [
      constraint({
        id: "constraint-domain-fact",
        type: "domain_fact",
        statement: "prices are stored in integer cents, never floating-point dollars, across the whole codebase",
        scope: ["src/billing/**", "src/payments/**"],
      }),
    ],
    expectedVerdict: "constraint_flag",
    expectedConstraintType: "domain_fact",
    futureLlmExpectation: "should_flag_as_conflict",
  },
  {
    id: "obvious-18-constraint-priority-tiebreak-review-required-wins",
    bucket: "obvious_conflict",
    category: "constraint_match",
    source: "manual",
    rationale:
      "Two constraints both match; the broader, lower-priority canonical_abstraction one is seeded FIRST in the " +
      "array (mirrors the shape of a real production incident this repo's own constraint file was fixed for) -- " +
      "proves review_required wins by priority, not by array order.",
    candidate: design({ id: "candidate", touches: ["src/payments/refund.ts"], summary: "Add a refund endpoint" }),
    openDesigns: [design({ id: "open-unrelated", touches: ["src/ui/theme.css"], summary: "Adjust dark mode contrast ratios" })],
    constraints: [
      constraint({
        id: "constraint-broad",
        type: "canonical_abstraction",
        statement: "use the shared validation helpers in src/validation/** everywhere",
        scope: ["src/**"],
      }),
      constraint({
        id: "constraint-narrow-review",
        type: "review_required",
        statement: "src/payments/** requires payments-team sign-off for any change",
        scope: ["src/payments/**"],
      }),
    ],
    expectedVerdict: "constraint_flag",
    expectedConstraintType: "review_required",
    expectedConstraintStatement: "src/payments/** requires payments-team sign-off for any change",
    futureLlmExpectation: "should_flag_as_conflict",
  },
  {
    id: "obvious-19-constraint-specificity-tiebreak",
    bucket: "obvious_conflict",
    category: "constraint_match",
    source: "manual",
    rationale: "Two same-priority (canonical_abstraction) constraints both match; the more specific/longer scope glob must win.",
    candidate: design({ id: "candidate", touches: ["src/billing/invoice-renderer.ts"], summary: "Render invoice PDFs with a new layout" }),
    openDesigns: [design({ id: "open-unrelated", touches: ["src/ui/theme.css"], summary: "Adjust dark mode contrast ratios" })],
    constraints: [
      constraint({
        id: "constraint-wide",
        type: "canonical_abstraction",
        statement: "general rule: avoid duplicating date-formatting logic, use src/utils/date.ts",
        scope: ["src/**"],
      }),
      constraint({
        id: "constraint-specific",
        type: "canonical_abstraction",
        statement: "invoice PDFs must use the invoice-specific date formatter in src/billing/invoice-date.ts, not the general one",
        scope: ["src/billing/invoice-*.ts"],
      }),
    ],
    expectedVerdict: "constraint_flag",
    expectedConstraintType: "canonical_abstraction",
    expectedConstraintStatement: "invoice PDFs must use the invoice-specific date formatter in src/billing/invoice-date.ts, not the general one",
    futureLlmExpectation: "should_flag_as_conflict",
  },

  // ---------------------------------------------------------------------
  // multi-design accumulation -- every case above has exactly one
  // openDesigns entry. runDesignChecks accumulates structuralConflicts
  // across a loop; nothing before this proved the returned conflicts array
  // actually contains every conflicting other, or that a per-other tier-1
  // hit doesn't suppress a tier-2-only hit on a *different* other in the
  // same call.
  // ---------------------------------------------------------------------
  {
    id: "obvious-20-multi-design-mixed-tiers",
    bucket: "obvious_conflict",
    category: "multi_design_accumulation",
    source: "manual",
    rationale:
      "3 open designs: one exact-touches overlap (tier 1), one dependency collision only (tier 2, no tier-1 match), " +
      "one fully unrelated. Asserts conflicts.length === 2 -- both real hits present, the unrelated third contributes " +
      "nothing, and the tier-1 continue for the first other doesn't suppress the tier-2 check running for the second.",
    candidate: design({ id: "candidate", creates: ["Foo"], touches: ["src/a.ts"], dependsOn: ["Bar"] }),
    openDesigns: [
      design({ id: "open-tier1", touches: ["src/a.ts"], summary: "Unrelated work that happens to touch src/a.ts" }),
      design({ id: "open-tier2", creates: ["Bar"], touches: ["src/unrelated-y.ts"], summary: "Builds Bar, which the candidate assumes exists" }),
      design({ id: "open-unrelated", creates: ["Zzz"], touches: ["src/z.ts"], summary: "Genuinely unrelated third design" }),
    ],
    expectedVerdict: "overlap",
    expectedConflictCount: 2,
    futureLlmExpectation: "should_flag_as_conflict",
  },
  {
    id: "obvious-21-multi-design-both-tier1",
    bucket: "obvious_conflict",
    category: "multi_design_accumulation",
    source: "manual",
    rationale: "2 open designs, both independently exact-overlap at tier 1 (different creates symbols each) -- asserts both land in the accumulated conflicts array, not just the first.",
    candidate: design({ id: "candidate", creates: ["Alpha", "Beta"] }),
    openDesigns: [
      design({ id: "open-p", creates: ["Alpha"], summary: "Also builds Alpha" }),
      design({ id: "open-q", creates: ["Beta"], summary: "Also builds Beta" }),
    ],
    expectedVerdict: "overlap",
    expectedConflictCount: 2,
    futureLlmExpectation: "should_flag_as_conflict",
  },

  // ---------------------------------------------------------------------
  // semantic_gap growth -- the actual reference standard for grading the
  // future LLM path's recall; this was the smallest bucket (3) before.
  // ---------------------------------------------------------------------
  {
    id: "gap-22-xss-sanitizer-duplicate-domain",
    bucket: "semantic_gap",
    category: "semantic_no_literal_overlap",
    source: "manual",
    rationale:
      "A fresh domain from gap-08/09/15's retry/backoff/debounce theme: two forms each independently get their own " +
      "input-sanitization fix against stored XSS, disjoint files, disjoint vocabulary. Jaccard 0.172.",
    candidate: design({
      id: "candidate",
      touches: ["src/forms/contact-form.ts"],
      summary: "Strip HTML tags and script content from the contact form's free-text fields before storing them, to prevent stored XSS",
    }),
    openDesigns: [
      design({
        id: "open-comment-box",
        touches: ["src/forms/comment-box.ts"],
        summary: "Clean up markup and executable content submitted through the comment box before saving, to close an XSS hole",
      }),
    ],
    expectedVerdict: "clean",
    futureLlmExpectation: "should_flag_as_conflict",
  },
  {
    id: "gap-23-stale-rename-assumption",
    bucket: "semantic_gap",
    category: "semantic_stale_assumption",
    source: "manual",
    rationale:
      "A temporal conflict shape distinct from gap-10's assert/negate pattern: one design renames/removes " +
      "fetchUser(id) entirely; another's plan calls fetchUser(id) as if it'll still exist. Neither side declares the " +
      "function name in creates/touches/dependsOn (an agent casually mentioning a call in prose, not formally " +
      "declaring a dependency, is exactly the realistic case), so no tier has anything to match on. Jaccard 0.095.",
    candidate: design({
      id: "candidate",
      touches: ["src/profile/loader.ts"],
      summary: "In the profile loader, call fetchUser(id) to load the current user's profile data on page load",
    }),
    openDesigns: [
      design({
        id: "open-rename",
        touches: ["src/api/client.ts"],
        summary: "Rename the legacy fetchUser(id) function to getUserById(id) across the codebase and remove the old name entirely",
      }),
    ],
    expectedVerdict: "clean",
    futureLlmExpectation: "should_flag_as_conflict",
  },
  {
    id: "gap-24-competing-canonicalization-email-sender",
    bucket: "semantic_gap",
    category: "semantic_competing_canonicalization",
    source: "manual",
    rationale:
      "Distinct from gap-10 (contradictory factual claims about behavior): here both designs agree on nothing being " +
      "wrong yet, they're each independently declaring themselves *the* canonical way to send email, with no " +
      "ratified constraint arbitrating between them yet. Jaccard 0.159 -- worded to avoid the two 'canonical email " +
      "sender' summaries accidentally sharing enough vocabulary for tier 4 to get lucky (an earlier, more literal " +
      "phrasing scored 0.79 and would have been wrongly caught -- this reworded version keeps it a genuine miss).",
    candidate: design({
      id: "candidate",
      touches: ["src/notifications/email-sender.ts"],
      summary:
        "Make EmailSender in src/notifications/email-sender.ts the single place transactional email goes out from -- other call sites should stop talking to the mail provider SDK directly and route through this instead.",
    }),
    openDesigns: [
      design({
        id: "open-mailer",
        touches: ["src/notifications/mailer.ts"],
        summary:
          "Introduce Mailer, a thin wrapper other parts of the app should use instead of importing the mail provider SDK themselves, so we're not scattered across the codebase calling it ad hoc.",
      }),
    ],
    expectedVerdict: "clean",
    futureLlmExpectation: "should_flag_as_conflict",
  },
  {
    id: "gap-25-near-miss-pagination-vs-known-false-positive",
    bucket: "semantic_gap",
    category: "semantic_near_miss_vocabulary",
    source: "manual",
    rationale:
      "The other side of bonus-11's boundary: bonus-11 crosses 0.5 (0.818) over two designs that are NOT actually " +
      "related. This case sits just under 0.5 (0.483, tuned iteratively -- an earlier phrasing landed at exactly " +
      "0.500 and would have been wrongly caught) over two designs that ARE the same underlying duplicate-work " +
      "problem (pagination added independently to two list views). Direct proof that tier 4's threshold isn't just " +
      "imprecise in one direction -- it's equally capable of missing a real near-duplicate as it is of flagging an " +
      "unrelated boilerplate pair.",
    candidate: design({
      id: "candidate",
      touches: ["src/orders/order-list.tsx"],
      summary:
        "The orders list loads every row up front and gets sluggish with a lot of data; fetch a fixed-size page at a time instead, with a control to load more.",
    }),
    openDesigns: [
      design({
        id: "open-invoices",
        touches: ["src/invoices/invoice-list.tsx"],
        summary:
          "The invoices table renders every row up front and lags with large accounts; fetch a fixed-size page at a time instead, with a button to load more.",
      }),
    ],
    expectedVerdict: "clean",
    futureLlmExpectation: "should_flag_as_conflict",
  },
];
