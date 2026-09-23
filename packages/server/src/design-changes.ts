/**
 * The guarantee that **every** design carries structured `changes[]`, no
 * matter which path registered it.
 *
 * Structured templates shipped in 0.2.27 reaching exactly one path --
 * `twing design register --from`. Plan mode (which the Go hook uses to
 * register most designs automatically, §17), a bare `--summary/--touches`
 * registration, and every amend all produced designs with no `changes` at
 * all, so twing-monitor fell back to bare path lists for almost every real
 * design. The feature was live and almost never visible.
 *
 * The fix is not "teach each caller to send changes" -- that is the shape
 * that produced the gap, and a new caller added later would reopen it
 * silently. Instead every design write funnels through `ensureChanges`
 * here, which **cannot return an empty list** when the design has any
 * declared scope at all. A path that forgets to supply changes does not
 * produce a design without them; it produces mechanically derived ones.
 *
 * Three sources, in precedence order:
 *
 *   1. **Client-supplied** (`register --from`) -- already validated
 *      client-side by `validateTemplate`, re-checked here because the
 *      server trusts no client field, the same rule `creates`/`touches`
 *      already follow.
 *   2. **LLM-extracted** (`design-extract.ts`, the ExitPlanMode path) --
 *      a plan is prose, and the model is the only thing that can read
 *      intent out of it.
 *   3. **Mechanically derived** from `creates`/`touches`. This is the one
 *      that makes the guarantee hold: no network, no model, no client
 *      support, no failure mode. An old CLI that has never heard of
 *      templates, an LLM outage, a plan with no usable prose -- all three
 *      still produce a real declaration.
 *
 * Source 3 is deliberately honest about being derived rather than
 * declared: its `intent` is prefixed to say so. A reader must be able to
 * tell "the author said this" from "we inferred this from a file list",
 * because the second is exactly as weak as the path list it came from, and
 * pretending otherwise would make the structured view *less* trustworthy
 * than the thing it replaced.
 *
 * **No I/O.** Same split `design-checks.ts` keeps: pure functions over
 * plain data, so every rule here is testable without a database or a
 * model.
 */

import {
  DESIGN_CHANGE_ACTIONS,
  DESIGN_CHANGE_KINDS,
  pathOfTarget,
  type DesignChange,
  type DesignChangeAction,
  type DesignChangeKind,
} from "@twing/core";

/** Path -> kind, deterministically.
 *
 * Ordered most-specific first, and the order is load-bearing:
 * `drizzle/meta/0016_snapshot.json` is a schema artifact rather than
 * config, and `packages/core/src/design-scope.test.ts` is a test rather
 * than code. A later rule can only ever apply to a path no earlier rule
 * claimed.
 *
 * Regexes rather than an extension lookup because the signal is often in
 * the directory (`migrations/`, `docs/`) rather than the suffix -- and
 * `schema.ts` carries its meaning in the basename, with a suffix shared by
 * every other kind here. */
const KIND_RULES: readonly { pattern: RegExp; kind: DesignChangeKind }[] = [
  { pattern: /(^|\/)(tests?|__tests__|spec)\//i, kind: "test" },
  { pattern: /[._-](test|spec)\.[a-z]+$/i, kind: "test" },
  { pattern: /_test\.go$/i, kind: "test" },
  { pattern: /(^|\/)(migrations?|drizzle)\//i, kind: "schema" },
  { pattern: /\.sql$/i, kind: "schema" },
  { pattern: /(^|\/)schema\.[a-z]+$/i, kind: "schema" },
  { pattern: /(^|\/)docs?\//i, kind: "docs" },
  { pattern: /\.(md|mdx|rst|txt)$/i, kind: "docs" },
  { pattern: /(^|\/)(config|\.github)\//i, kind: "config" },
  { pattern: /\.(ya?ml|toml|ini|cfg|conf)$/i, kind: "config" },
  { pattern: /(^|\/)(package\.json|tsconfig[^/]*\.json|\.env[^/]*)$/i, kind: "config" },
  { pattern: /(^|\/)(routes?|api|controllers?|handlers?|endpoints?)\//i, kind: "api" },
  { pattern: /[._-](route|router|controller|handler|api)\.[a-z]+$/i, kind: "api" },
];

/** The kind a path is treated as when nobody said. `code` is the default
 * everywhere else too (`kindOf`), so an unmatched path lands where an
 * absent `kind` field already would. */
export function inferKind(target: string): DesignChangeKind {
  const path = pathOfTarget(target);
  for (const rule of KIND_RULES) {
    if (rule.pattern.test(path)) return rule.kind;
  }
  return "code";
}

/** Marks an `intent` as inferred rather than authored. Exported so the
 * test can assert the distinction survives, and so a reader or UI can
 * detect a derived change without re-running the inference. */
export const DERIVED_INTENT_PREFIX = "(derived from declared scope)";

/**
 * The ids in `final` whose `kind` this module guessed from the path, rather
 * than the caller having written one down.
 *
 * The async re-classification pass (`design-kind-classify.ts`) is only ever
 * allowed to touch these. An author who typed `kind: api` said something
 * deliberate, and a model overruling it would be the same broken trade this
 * whole module exists to avoid -- see `ensureChanges`'s "declared intent
 * must survive verbatim" and `DERIVED_INTENT_PREFIX` above, which exist for
 * exactly this authored-vs-derived distinction.
 *
 * Computed by re-reading `supplied` (the caller's raw template, in whatever
 * shape it arrived) rather than stored on the change, because a stored
 * provenance flag is one more field every write path could forget to set --
 * the same failure mode that left `changes` empty for almost every design
 * before `ensureChanges` existed. On the fully-derived path `supplied`
 * names nothing, so every id is inferred, which is correct.
 */
export function pathInferredChangeIds(supplied: unknown, final: DesignChange[]): string[] {
  const authored = new Set<string>();
  if (Array.isArray(supplied)) {
    for (const item of supplied) {
      if (!isValidChange(item)) continue;
      // Only an explicit, *valid* kind counts as authored. A bogus one was
      // already rejected by `isValidChange`, so the row it belongs to never
      // reached `final` under its own terms anyway.
      if (item.kind !== undefined) authored.add(item.id);
    }
  }
  return final.filter((c) => !authored.has(c.id)).map((c) => c.id);
}

function isValidChange(value: unknown): value is DesignChange {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  if (typeof c.id !== "string" || c.id.length === 0) return false;
  if (typeof c.target !== "string" || c.target.length === 0) return false;
  if (typeof c.intent !== "string") return false;
  if (typeof c.action !== "string" || !DESIGN_CHANGE_ACTIONS.includes(c.action as DesignChangeAction)) return false;
  if (c.kind !== undefined && (typeof c.kind !== "string" || !DESIGN_CHANGE_KINDS.includes(c.kind as DesignChangeKind))) return false;
  return true;
}

/** Keeps only well-formed items, and stamps a `kind` on any that lack one.
 *
 * Filtering rather than rejecting the whole list: a client sending one bad
 * item should not lose the other nine, and the alternative (400 the
 * registration) would turn a cosmetic problem into a blocked edit on a
 * path that must never block. */
function normalizeSupplied(changes: unknown): DesignChange[] {
  if (!Array.isArray(changes)) return [];
  return changes.filter(isValidChange).map((c) => ({ ...c, kind: c.kind ?? inferKind(c.target) }));
}

export interface DeriveInput {
  /** Client-supplied or LLM-extracted -- the caller passes whichever it
   * has, in that precedence order. */
  changes?: unknown;
  creates?: string[];
  touches?: string[];
  /** Used only as the derived `intent`, so a derived change still says
   * something about *why* rather than repeating the filename. */
  summary?: string;
}

/**
 * Always returns the design's `changes[]` -- supplied if usable, derived
 * otherwise. Empty only when the design declares no scope at all, which is
 * the one case where there is genuinely nothing to describe.
 *
 * `creates` becomes `add` and `touches` becomes `modify`, the exact
 * inverse of `deriveScope` (core's `design-scope.ts`). That symmetry
 * matters: a derived design round-trips back to the same
 * `creates`/`touches` it came from, so nothing downstream sees a scope
 * that drifted from what the author actually declared.
 *
 * Ids are positional (`c1`, `c2`, ...) and stable for a given input, so a
 * re-derivation produces the same ids rather than churning them on every
 * amend.
 */
export function ensureChanges(input: DeriveInput): DesignChange[] {
  const supplied = normalizeSupplied(input.changes);
  if (supplied.length > 0) return supplied;

  const creates = input.creates ?? [];
  const touches = input.touches ?? [];
  // Deduped against creates: a path declared in both is an `add`, matching
  // `deriveScope`, which puts a path in exactly one bucket.
  const createSet = new Set(creates);
  const derived: DesignChange[] = [];
  const seen = new Set<string>();
  const intent = input.summary && input.summary.length > 0 ? `${DERIVED_INTENT_PREFIX} ${input.summary}` : DERIVED_INTENT_PREFIX;

  const push = (target: string, action: DesignChangeAction) => {
    if (target.length === 0 || seen.has(target)) return;
    seen.add(target);
    derived.push({ id: `c${derived.length + 1}`, action, kind: inferKind(target), target, intent });
  };

  for (const t of creates) push(t, "add");
  for (const t of touches) {
    if (!createSet.has(t)) push(t, "modify");
  }
  return derived;
}

/**
 * The amend counterpart: the design's full `changes[]` after a scope
 * amendment, preserving what was already declared.
 *
 * Existing items are kept **verbatim and first**. They carry authored
 * intent that nothing here can reconstruct, and reordering them would
 * churn the display on every amend.
 *
 * Appended items come from `supplied` when the caller sent a template
 * (`amend --from`), and are otherwise derived from whichever added paths
 * aren't already the target of an existing change. That last clause is
 * what keeps a repeat amend idempotent: re-adding a path already declared
 * changes nothing, rather than stacking a second identical row.
 *
 * Ids are made unique against what is already there, since a hand-written
 * `amend --from` fragment has no way to know which ids the design already
 * uses -- the out-of-scope deny literally tells the author to "pick an id
 * no other change in this design already uses", which is a rule a human
 * will get wrong eventually. Renaming the incoming duplicate is strictly
 * better than rejecting the amend or silently overwriting the original.
 */
export function mergeChanges(existing: DesignChange[] | undefined, input: DeriveInput): DesignChange[] {
  const kept = normalizeSupplied(existing);
  const claimed = new Set(kept.map((c) => c.target));
  const usedIds = new Set(kept.map((c) => c.id));

  const supplied = normalizeSupplied(input.changes);
  const incoming =
    supplied.length > 0
      ? supplied
      : ensureChanges({
          creates: (input.creates ?? []).filter((p) => !claimed.has(p)),
          touches: (input.touches ?? []).filter((p) => !claimed.has(p)),
          summary: input.summary,
        });

  const appended: DesignChange[] = [];
  for (const change of incoming) {
    if (claimed.has(change.target)) continue;
    claimed.add(change.target);
    let id = change.id;
    for (let n = 2; usedIds.has(id); n += 1) id = `${change.id}-${n}`;
    usedIds.add(id);
    appended.push({ ...change, id });
  }
  return [...kept, ...appended];
}
