/**
 * Structured design templates (2026-09) -- parsing, validation, and the
 * derivation of the legacy scope fields from them.
 *
 * A `DesignStatement` has always declared *where* work will happen
 * (`creates`/`touches`, two bags of file paths) and never *what* will happen
 * there. Adding a shelf and knocking down a wall are indistinguishable in
 * that shape, which is why design-vs-code conformance has never been
 * checkable without handing a diff and some prose to a model and hoping.
 *
 * A template fixes that with three fields per item -- `action`, `target`,
 * `intent`. The load-bearing one is `target`: it uses **the same
 * `path::Symbol.method` format `Claim.symbolId` already uses**
 * (`symbol-id.ts`'s `computeSymbolId`). That shared namespace is the whole
 * point -- with it, "did you build what you said" is a set difference
 * between declared targets and recorded claims, with no model involved:
 *
 *     declared − actual  = declared, never built
 *     actual   − declared = built, never declared
 *
 * Do not introduce a second spelling for `target`. Everything this is for
 * depends on the two namespaces staying identical.
 *
 * **Nothing here does I/O.** Reading the file and checking targets against a
 * working tree belong to the caller (`packages/cli/src/design.ts`), same
 * split `manifest.ts` keeps between `parseManifest` and
 * `loadManifestFromFile`, and for the same reason: it keeps every rule in
 * here testable with plain strings.
 */

import { parse as parseYaml } from "yaml";
import type { DesignChange, DesignChangeAction } from "./types.js";

/** The six actions, as a runtime value -- `DesignChangeAction` is compile-time
 * only, and validation needs something to check against at runtime. Kept
 * adjacent to the type so the two cannot drift silently. */
export const DESIGN_CHANGE_ACTIONS: readonly DesignChangeAction[] = [
  "add",
  "modify",
  "rewrite",
  "remove",
  "rename",
  "move",
] as const;

/** The two actions that assert behaviour did NOT change, and so require a
 * `from` (the previous name, or the previous path). The rest must not carry
 * one -- a `from` on a `modify` is meaningless and almost certainly a
 * mistake worth surfacing rather than ignoring. */
const ACTIONS_REQUIRING_FROM: readonly DesignChangeAction[] = ["rename", "move"] as const;

export interface DesignTemplate {
  /** One sentence: what changes for the user or the system. Becomes the
   * design's `summary`. */
  goal: string;
  changes: DesignChange[];
}

/** A single problem found in a template. `changeId` is absent for problems
 * with the document as a whole (no `goal`, `changes` not a list). */
export interface TemplateProblem {
  changeId?: string;
  message: string;
}

/** `src/net/retry.ts::RetryPolicy.backoff` -> `src/net/retry.ts`.
 *
 * The inverse of `computeSymbolId` (symbol-id.ts), which is what guarantees
 * a derived path matches what a Claim for the same symbol would report. */
export function pathOfTarget(target: string): string {
  const separator = target.indexOf("::");
  return separator === -1 ? target : target.slice(0, separator);
}

/**
 * Derives `creates`/`touches` from a structured declaration.
 *
 * This exists so the legacy fields keep working **untouched** for every
 * existing reader: `pathInDesignScope` (the Edit/Write gate),
 * `hook/design_gate.go` (which reads `touches` back for its
 * missing-files warning) and twing-monitor all still consume them and need
 * no changes at all. The structured form is additive on top, never a
 * replacement.
 *
 * Deduped, because several changes routinely target one file -- three edits
 * to `retry.ts` must not produce three identical `touches` entries.
 *
 * `action: "add"` is the only thing that lands in `creates`; everything
 * else, including `remove`, is a `touches`. That matches how the gate
 * already reasons -- both arrays are checked as one combined scope by
 * `pathInDesignScope`, so the split only affects display.
 */
export function deriveScope(changes: DesignChange[]): { creates: string[]; touches: string[] } {
  const creates = new Set<string>();
  const touches = new Set<string>();
  for (const change of changes) {
    const path = pathOfTarget(change.target);
    if (path.length === 0) continue;
    (change.action === "add" ? creates : touches).add(path);
  }
  return { creates: [...creates], touches: [...touches] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Parses template YAML into a `DesignTemplate`, tolerating anything.
 *
 * Never throws: a malformed document returns an empty template, and
 * `validateTemplate` below is what reports why. Keeping parse and validate
 * separate means the caller can show *every* problem at once rather than
 * failing on the first -- which matters a lot here, since the whole point of
 * a template is that a human hand-writes it.
 */
export function parseDesignTemplate(yamlText: string): DesignTemplate {
  let document: unknown;
  try {
    document = parseYaml(yamlText);
  } catch {
    return { goal: "", changes: [] };
  }
  if (!isRecord(document)) return { goal: "", changes: [] };

  const rawChanges = Array.isArray(document.changes) ? document.changes : [];
  const changes: DesignChange[] = rawChanges.filter(isRecord).map((raw, index) => {
    const change: DesignChange = {
      // A missing id is a validation problem, not a parse failure -- but
      // every later message needs something to name the item by, so fall
      // back to its position rather than an empty string.
      id: asTrimmedString(raw.id) || `#${index + 1}`,
      action: asTrimmedString(raw.action) as DesignChangeAction,
      target: asTrimmedString(raw.target),
      intent: asTrimmedString(raw.intent),
    };
    const from = asTrimmedString(raw.from);
    return from ? { ...change, from } : change;
  });

  return { goal: asTrimmedString(document.goal), changes };
}

/**
 * Every problem with a template, in document order -- document-level first,
 * then per change. An empty array means it is safe to register.
 *
 * Deliberately returns *all* problems rather than throwing on the first:
 * a developer fixing a hand-written file should see the whole list in one
 * pass, not discover the next error only after fixing this one. Same
 * reasoning `matchConstraintsForPaths` (design-checks.ts) uses for returning
 * every constraint hit instead of one "best" one.
 */
export function validateTemplate(template: DesignTemplate): TemplateProblem[] {
  const problems: TemplateProblem[] = [];

  if (template.goal.length === 0) {
    problems.push({ message: 'missing `goal:` -- one sentence describing what this achieves' });
  }
  if (template.changes.length === 0) {
    problems.push({ message: "no `changes:` declared -- a template with no changes says nothing" });
  }

  const seenIds = new Set<string>();
  for (const change of template.changes) {
    const at = change.id;

    if (seenIds.has(at)) {
      problems.push({ changeId: at, message: `duplicate id "${at}" -- ids must be unique within a design` });
    }
    seenIds.add(at);

    if (change.action.length === 0) {
      problems.push({ changeId: at, message: `missing \`action:\` -- one of ${DESIGN_CHANGE_ACTIONS.join(" · ")}` });
    } else if (!DESIGN_CHANGE_ACTIONS.includes(change.action)) {
      problems.push({
        changeId: at,
        message: `unknown action "${change.action}" -- valid: ${DESIGN_CHANGE_ACTIONS.join(" · ")}`,
      });
    }

    if (change.target.length === 0) {
      problems.push({ changeId: at, message: "missing `target:` -- a path, or path::Symbol.method" });
    }
    if (change.intent.length === 0) {
      problems.push({ changeId: at, message: "missing `intent:` -- one sentence on what this achieves" });
    }

    // `from` is required by exactly the two actions that claim behaviour did
    // not change, and meaningless everywhere else. Both directions are worth
    // reporting: a rename with no `from` can't be checked, and a `from` on a
    // `modify` means the author probably meant `rename`.
    const needsFrom = ACTIONS_REQUIRING_FROM.includes(change.action);
    if (needsFrom && !change.from) {
      problems.push({ changeId: at, message: `\`${change.action}\` needs \`from:\` -- the previous ${change.action === "rename" ? "name" : "path"}` });
    }
    if (!needsFrom && change.from && DESIGN_CHANGE_ACTIONS.includes(change.action)) {
      problems.push({ changeId: at, message: `\`from:\` only applies to rename/move, not \`${change.action}\`` });
    }
  }

  return problems;
}

/**
 * Suggests the closest valid action for a typo'd one, or `undefined` when
 * nothing is close enough to be worth guessing at.
 *
 * Plain prefix/substring matching rather than an edit-distance
 * implementation: the set is six short words, the realistic mistakes are
 * `renamed`/`moved`/`added` (tense) and `refactor` (a word people reach for
 * that deliberately does not exist here -- see docs/structured-design-schema.md
 * on why `rename`/`move` stay separate). An approximate matcher earns
 * nothing over this and is more code to be wrong.
 */
export function suggestAction(invalid: string): DesignChangeAction | undefined {
  const candidate = invalid.trim().toLowerCase();
  if (candidate.length === 0) return undefined;
  return DESIGN_CHANGE_ACTIONS.find((action) => action.startsWith(candidate) || candidate.startsWith(action));
}
