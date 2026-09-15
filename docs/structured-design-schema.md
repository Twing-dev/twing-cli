# Structured design statements

**Status:** proposal · not implemented
**Affects:** `DesignStatement` (`packages/core/src/types.ts`), `design-extract.ts`, `designs` table, `twing design register`
**Written against:** `@twing/cli` 0.2.25

---

## Summary

A `DesignStatement` today is four flat string arrays. This proposes replacing them
with a **typed list of changes** and a **list of verifications**, both drawn from
closed vocabularies — 8 kinds × 8 actions × 5 verification types, and nothing else,
ever.

The point is not that a structured design reads better, although it does. It is that
a structured design makes design-vs-code conformance **computable** instead of
something a language model has to reconstruct from prose.

---

## 1. The problem

### 1.1 Today's shape

```ts
interface DesignStatement {
  summary: string;
  creates: string[];      // ["src/net/retry.ts"]
  touches: string[];      // ["src/net/http-client.ts", "drizzle/0014.sql", ".twing/twing.yml"]
  dependsOn: string[];
  rawPlanExcerpt?: string;
}
```

Three things this cannot express:

**It flattens kinds together.** In the `touches` array above, a source file, a
database migration and a config file are indistinguishable. They have completely
different review questions — "does the code match the intent", "is the migration
reversible", "does this drift between environments" — and none of them can be asked,
because the shape doesn't record which is which.

**It flattens actions together.** "I renamed this" and "I rewrote this" both appear
as membership in `touches`. Those are opposite claims: one asserts behaviour did not
change, the other asserts it may have changed entirely.

**Granularity doesn't match what actually gets recorded.** A design declares
`src/net/retry.ts`. A `Claim` records `src/net/retry.ts::RetryPolicy.backoff`.
Different namespaces, so comparing them requires a model to bridge the gap.

### 1.2 Why this blocks the review system

The proposed change-time review system (see `documentation/review-flow.html`) must
answer "did you build what you said you would." With the current shape, that question
can only be handed to an LLM along with a diff and some prose — which is exactly the
low-signal, high-noise approach the review design is trying to avoid.

---

## 2. The core idea

> **Design targets and claim `symbolId`s live in the same namespace.**

Once both use `path::Symbol.method`, the central review question stops being a
judgement call and becomes two set operations:

```
declared targets  −  actual claims     =  declared, never built
actual claims     −  declared targets  =  built, never declared
```

No model call. No prompt. No false positives. Everything an LLM does afterwards is
judgement layered on a skeleton that is already known to be correct, rather than
reconstruction from scratch.

### 2.1 Constraint: this codebase deletes categories that don't change behaviour

Before proposing new vocabulary, note what this repository has already done to its
own.

`DesignConstraintType` was collapsed from three values to one on 2026-08-26. From its
doc comment in `packages/core/src/types.ts`:

> Collapsed from a three-way `"canonical_abstraction" | "domain_fact" |
> "review_required"` union to a single value. Checked against every reader in the
> codebase (matching, severity, blocking, the admin-justify resolution flow) and
> found they **treated all three identically** — the only thing `type` ever changed
> was which one-line phrase a deny message printed.

`DesignSeverity` was removed entirely in the same pass, because once the verdict
determined blocking, severity could no longer vary independently of it. And
`.twing/twing.yml` records the operational conclusion:

> There is no lighter tier — `require_human_review` and `constraints` both seed as
> type `"constraint"` since the 4-bucket simplification (2026-08-26), so the two
> sections are the same mechanism wearing different names.

**The doctrine: a value earns its place by changing what the system *does*, not by
describing something accurately.** A vocabulary of 8 × 8 is exactly the kind of thing
that doctrine has twice deleted.

So every value below carries a status:

- **active** — a check reads it today, or in the immediate build
- **reserved** — the name is fixed so nobody invents a different spelling later, but
  nothing acts on it and it must not be emitted until a check needs it

Reserving rather than shipping keeps the vocabulary closed — which is the point —
without repeating the `canonical_abstraction` mistake. Promotion later is a one-line
change; invention later is a migration.

### 2.2 Relationship to the existing buckets

These are different axes and should not be conflated:

| Enum | Answers |
|---|---|
| `DesignVerdict` — `file_overlap` · `constraint_violation` · `symbol_conflict` · `llm_divergence` | *What kind of conflict was found* |
| `changes[].kind` — proposed below | *What kind of artifact is being changed* |

They are orthogonal: a `schema` change can produce a `symbol_conflict`.

One existing enum does overlap. `DesignOverlapKind = "creates" | "touches" |
"constraint" | "symbol"` mixes two axes — `creates`/`touches` become derivable from
`action` once `changes[]` exists. That enum should be expected to **shrink** as a
consequence of this proposal, not grow.

---

## 3. `kind` — what is being changed

Eight names. Closed. **Five active, three reserved** — see §2.1.

| `kind` | Status | Covers | The check that justifies it |
|---|---|---|---|
| `code` | **active** | Internal implementation — functions, classes, modules | Conformance against intent; bug hunt |
| `api` | **active** | Anything callers outside your control depend on: HTTP routes, exported signatures, CLI flags, wire-protocol messages | Signature comparison plus a caller scan — a check no other kind runs |
| `schema` | **active** | Persistent data shape — tables, migrations, indexes | `migration`/`backfill` reasoning; these fields exist nowhere else |
| `test` | **active** | Test code | The entire test-quality family |
| `docs` | **active** | Prose, comments, README | *Skips* the expensive checks — it changes what runs, which is a behavioural difference |
| `config` | reserved | Runtime behaviour without code — env vars, YAML, feature flags, deploy manifests | Environment drift. **Not specified yet — do not emit.** |
| `dependency` | reserved | Third-party packages, lockfiles | Version/supply-chain. **No check exists — do not emit.** |
| `build` | reserved | Toolchain — CI workflows, `tsconfig`, `Dockerfile`, package scripts | Build reproducibility. **No check exists — do not emit.** |

**Default when unsure: `code`.** There is no ninth name. If something genuinely does
not fit, that is a signal the change is doing two things and should be two items.

> The three reserved kinds are honest about their own status. Each describes a real
> distinction, but so did `canonical_abstraction` and `domain_fact` — and those were
> deleted precisely because describing a real distinction is not the same as driving
> one. Promote a kind the day a check reads it, not before.

> `api` is deliberately separate from `code`. The distinction is not where the code
> lives, it is **who breaks if you get it wrong** — a `code` change breaks you, an
> `api` change breaks someone you can't see.

> `docs` earns its slot by being the one kind where the correct behaviour is to do
> *less*. Without it, prose-only changes burn model calls producing nothing.

---

## 4. `action` — what is happening to it

Eight names. Closed. **Six active, two reserved.** They split on one question:
**is behaviour supposed to change?**

### 4.1 Behaviour changes — review proves the stated change happened

| `action` | Status | Means | Review asserts |
|---|---|---|---|
| `add` | **active** | Didn't exist, now does | New behaviour matches intent, and is verified |
| `modify` | **active** | Exists, changed incrementally | The delta matches intent |
| `rewrite` | **active** | Exists, but substantially replaced | The **whole resulting symbol** matches intent, not just the delta |
| `remove` | **active** | Existed, now gone | Nothing still references it |

### 4.2 Structure only — review proves nothing changed

| `action` | Status | Means | Review asserts — deterministically |
|---|---|---|---|
| `rename` | **active** | Same thing, new name | Body identical, name differs |
| `move` | **active** | Same thing, new location | Body identical, path differs |
| `extract` | reserved | One thing split into several | Body partition. **Unbuilt — do not emit.** |
| `inline` | reserved | Several folded into one | Inverse of `extract`. **Unbuilt — do not emit.** |

**Default when unsure: `modify`.**

> `rename` and `move` stay separate despite sharing one assertion ("the body is
> identical") because `from` means something different in each — a previous *name*
> versus a previous *path* — and each comparison is a different one-line check.
> `extract`/`inline` are reserved because their partition check is genuinely
> non-trivial and nobody has built it.

### 4.3 Why the split matters

`rewrite` versus `modify` changes what review does: for `modify` it checks the diff,
for `rewrite` it re-checks the entire resulting symbol against intent. A very large
diff declared as `modify` is itself a finding.

The second bucket is the more valuable one. **"I only renamed it" is a checkable
claim.** If the body changed too, that is a silent behaviour change hiding inside a
refactor — which is precisely where bugs hide and where human reviewers stop looking.
A single blanket `refactor` action could not catch that; four specific ones can, and
all four checks are pure AST comparisons with no model involved.

### 4.4 Valid combinations

Every action is valid for every kind, with three exceptions that should be rejected
at validation time:

- `extract` / `inline` on `dependency` — meaningless
- `rename` / `move` on `dependency` — use `add` + `remove`
- `extract` / `inline` on `config` — config has no call structure to partition

---

## 5. `verification.how`

Five values. Closed.

| value | Means |
|---|---|
| `unit` | Isolated, no I/O |
| `integration` | Crosses a real boundary |
| `e2e` | The full path, as a user experiences it |
| `manual` | A human will check it — the entry must name what they check |
| `none` | **Deliberately untested, with a stated reason** |

`none` is the value that earns its place. An honest "this isn't worth testing because
X" should be **respected** by review, not flagged. What gets flagged is silence —
a change with no verification covering it at all.

---

## 6. The shape

```yaml
goal: "Outbound HTTP survives transient failures without thundering herd"

changes:
  - id: c1
    kind: code
    action: modify
    target: src/net/retry.ts::RetryPolicy.backoff
    intent: "exponential growth, capped at 30s"

  - id: c2
    kind: code
    action: add
    target: src/net/retry.ts::RetryPolicy.jitter
    intent: "full jitter so retries desynchronise"

  - id: c3
    kind: code
    action: rename
    target: src/net/retry.ts::RetryPolicy.reset
    from: RetryPolicy.clear                 # rename / move only
    intent: "name matches the other lifecycle methods"

  - id: c4
    kind: schema
    action: add
    target: packages/server/drizzle/0016_retry_state.sql
    intent: "record last attempt timestamp per endpoint"
    migration: forward-only                 # schema only: forward-only | reversible
    backfill: none                          # schema only: none | required | done

  - id: c5
    kind: api
    action: modify
    target: GET /v1/claims
    intent: "add a ?since= filter"
    compatible: true                        # api only

verification:
  - id: v1
    behaviour: "backoff grows exponentially and caps at 30s"
    how: unit
    covers: [c1]

  - id: v2
    behaviour: "a 503 burst produces desynchronised retries"
    how: integration
    covers: [c1, c2]

  - id: v3
    behaviour: "the rename is behaviour-neutral"
    how: none
    because: "pure rename — verified structurally, not by a test"
    covers: [c3]
```

### 6.1 Field reference

**Universal, on every change item**

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Stable within the design. Findings point at it. |
| `kind` | yes | One of the eight. |
| `action` | yes | One of the eight. |
| `target` | yes | `path`, `path::Symbol`, `path::Symbol.method`, or a route/flag for `api`. |
| `intent` | yes | One sentence: what this achieves, not what it does mechanically. |

**Kind-specific — the complete set. There are four.**

| Field | On | Values |
|---|---|---|
| `from` | `rename`, `move` | The previous name or path |
| `migration` | `schema` | `forward-only` \| `reversible` |
| `backfill` | `schema` | `none` \| `required` \| `done` |
| `compatible` | `api` | `true` \| `false` |

**Verification items**

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Stable within the design |
| `behaviour` | yes | Stated as an observable outcome, not as a test name |
| `how` | yes | One of the five |
| `covers` | yes | Change ids this verifies |
| `because` | only when `how: none` | Why this is deliberately untested |

### 6.2 Optional sections

Three further sections are defined but **should not be built until a specific check
needs one.** Listing them here is to fix their names now, so they aren't invented
differently later.

```yaml
contracts: [ "RetryPolicy.backoff stays signature-compatible" ]
decisions: [ { choice: "full jitter", over: ["decorrelated jitter"], because: "..." } ]
reads:     [ "env RETRY_MAX_ATTEMPTS", "HttpClient" ]
```

---

## 7. Two rules that keep it honest

### 7.1 Absence means "not stated", never "nothing"

Every section and every optional field is optional. A design with no `contracts`
block means no contracts were declared. Review must report that as **not checkable**,
never as a violation.

Without this rule, a richer schema makes the tool *more* wrong on partial input —
and partial input is most input.

### 7.2 Separate commitments from expectations

A design is written before the code exists. Some of it is assertion, some is
forecast:

- *"This must stay backward compatible"* — a **commitment**. Checkable. A violation
  if broken.
- *"I'll probably also touch `retry.ts`"* — an **expectation**. Informational. Not a
  violation if wrong.

`changes[]` entries are expectations. `contracts[]` entries, `compatible`, and
`migration` are commitments. A richer schema invites false precision; this is the
guard against it.

---

## 8. What it unlocks

With this shape, these checks need **no model at all**:

| Check | Method |
|---|---|
| Declared but not built | Set difference over targets |
| Built but not declared | Reverse set difference |
| `rename`/`move` that changed behaviour | AST body comparison |
| `extract`/`inline` that changed behaviour | AST body partition check |
| Change with no verification covering it | `covers` reachability |
| `modify` with a suspiciously large diff | Line count versus declared action |
| `schema` change with `backfill: required` and no backfill in the diff | Path scan |
| `api` change with `compatible: true` but a changed signature | Signature comparison |

Only *"does the implementation match the stated intent"* genuinely needs a language
model — and by then it is working from a verified skeleton rather than a diff.

### 8.1 It improves the gate before review exists

This is worth landing on its own merits. A typed `changes[]` lets the existing §17
Edit/Write gate say:

> *You're editing a migration, but this design only declared `code` changes.*

which is strictly better than today's path-membership check. **The investment pays
off even if the review system slips.**

---

## 9. Rendering

One artifact serves as the design, the progress view, and the review result:

```
Design 40025938 · "Outbound HTTP survives transient failures"
                                     5 changes · 3 verifications · 2 problems

  CODE
    ✓ c1  modify   RetryPolicy.backoff        matches intent        v1 v2
    ✓ c2  add      RetryPolicy.jitter         matches intent        v2
    ⚠ c3  rename   RetryPolicy.reset          BODY ALSO CHANGED     v3
                   ↳ declared behaviour-neutral, but 14 lines differ

  SCHEMA
    ✗ c4  add      0016_retry_state.sql       DECLARED, NOT BUILT   —

  API
    ✓ c5  modify   GET /v1/claims             compatible            —
                   ↳ no verification covers this

  UNDECLARED
    ⚠ —   modify   HttpClient.request         BUILT, NOT DECLARED
```

Three of those four findings are computed deterministically. Only "matches intent"
consulted a model.

---

## 10. Backward compatibility

**Derive, don't replace.** `creates` and `touches` become computed columns:

```
creates = changes.filter(c => c.action === "add").map(c => pathOf(c.target))
touches = changes.filter(c => c.action !== "add").map(c => pathOf(c.target))
```

Consequences:

- `pathInDesignScope` — unchanged
- `hook/design_gate.go` — unchanged, reads nothing new
- `twing-monitor` — unchanged, keeps rendering the old fields
- Pre-existing design rows — have no `changes`, and readers tolerate its absence

This follows the schema's existing **never backfill** convention: a new column leaves
old rows alone, and every reader handles absence. `changes` is purely additive.

---

## 11. Extraction

Extraction (`design-extract.ts`) gets harder: one model call producing a typed
structure hallucinates more than one producing four string arrays.

**Mitigation, which twing can do and a diff-only tool cannot: validate every
extracted target against the actual repository.** Tree-sitter is already a
dependency. If extraction claims `RetryPolicy.jitter`, and no such symbol exists, and
no `action: add` was declared for it, drop the item before persisting.

`hook/design_gate.go` already does a crude version of this in
`warnIfTouchesMissing`. Doing it properly kills hallucinated targets at the door.

Suggested acceptance bar, matching the precedent set by the semantic comparator's
25-case labelled eval: **zero hallucinated targets**, measured against real plan text
from this repository's own design history.

---

## 12. Open questions

1. **Manual registration.** `twing design register --summary "…" --touches a,b` does
   not survive contact with a nested schema. Plan mode handles the common path via
   extraction; the manual path likely becomes "open an editor with a template"
   rather than more flags.
2. **Amendment semantics.** `DesignRegistry.amend` currently unions string arrays.
   With typed items, does an amend add items, or may it modify an existing item's
   `action`/`intent`? Adding is clearly safe; mutating is not.
3. **Target syntax for non-code kinds.** `path::Symbol.method` is natural for `code`.
   `api` items need a convention — `GET /v1/claims` is used above, but CLI flags and
   wire messages need one too.
4. **Item count ceiling.** A large design could declare 200 changes. The rendering
   above and the review pipeline both need a cap and a ranking.

---

## 13. Recommendation

**Sequencing: do this before building the review system.** Building review against
the flat shape means writing prompts to compensate for missing structure, and then
discarding them.

**Scope: `changes[]` and `verification[]` only.** Ship those two. Add `contracts`,
`decisions` and `reads` when a specific check demands one — not speculatively.

**The vocabularies are closed, and partly reserved.** Eight kind names, eight action
names, five verification types, four kind-specific fields — but only **five kinds and
six actions ship active**. The rest have their spelling fixed and nothing else, so a
future check promotes a name instead of inventing one.

That split is the deliberate compromise between two things this project wants at
once: a closed vocabulary nobody extends ad hoc, and §2.1's doctrine that a value
which changes no behaviour gets deleted. Shipping all thirteen as active would
reproduce `canonical_abstraction` exactly — and that took a dedicated simplification
pass to undo.

Defaults (`code`, `modify`) exist precisely so nobody reaches for a reserved name.
If a change genuinely doesn't fit an active value, that is evidence it is two
changes.
