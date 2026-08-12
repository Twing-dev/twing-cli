# Statefulness and identity, before the review UI

**Re:** §17 design gate — evolution toward a design-review system
**Date:** 2026-08-12
**Status:** proposal, not started

> Even before a review UI, the server needs to be stateful first — a running log of what got proposed, refined, modified, approved, and reverted. That's the greatest business value. User identity needs to be hardened alongside it.

## Where this started

We discussed evolving the design-conflict gate (§17) into a full review system — a UI over gate logs, an approval workflow for justified divergences, and Google-Docs-style commenting on plan artifacts. All three are legitimate directions. But a UI is a window onto data, and right now the data it would need to show mostly doesn't exist, or exists only as a snapshot that overwrites itself. Building the window before the room has a floor gets the sequence backwards.

## What the server actually holds today

Checked directly against `packages/server/src/design-store.ts` and the gate's call sites — this is worse than "no audit log," it's *lossy* state:

- **`DesignRegistry`** — in-memory, TTL-swept. Restart `twing serve` and every open design and every pending review is gone. Only the constraint file survives; everything else has no floor under it at all.
- **State transitions** — mutated in place (`d.status = "superseded"`). Even while the process is running, there's no way to see that a transition happened — only its result. The record of the decision is discarded the moment the decision is made.
- **"Refined"** — no mechanism, not just no log. Every `ExitPlanMode` call, including a mid-session replan after a denial, registers a brand-new design with a fresh id. Nothing links a revised plan to the attempt it revised.
- **"Modified"** — `ConstraintStore.add()` is create-or-return-existing only. No update path, no versioning, no retraction.
- **"Reverted"** — two different things, and one of them we can't see at all. Reversing a review decision has no mechanism. A change getting reverted in git after approval — twing has zero visibility into commit history today; that's a different, unscoped capability, not a state-model fix.
- **Every write** — authenticated by one shared team password. No accounts. Nothing recorded today is attributable to a real person.

## The reframe: a system of record, not a database bolted on

The fix isn't wrapping today's shape in a database — it's making an append-only event log the source of truth: `registered`, `checked → verdict`, `revised`, `resolve_requested`, `review_created`, `review_decided`, `closed`/`expired` — each event carrying a real actor and a timestamp. `DesignRegistry` and `ConstraintStore` become *projections* rebuilt from that log at boot, not independently maintained stores. One change fixes the restart-durability hole and produces the history as a side effect, instead of state and history being two things kept in sync by hand.

This is consistent with this project's own existing bias (§16: "no DB, JSON snapshot is the cheapest durability upgrade") — an append-only JSON-lines file, replayed into in-memory projections at startup, is proportionate. This doesn't need to become a general event-sourcing platform; it needs to model exactly the transitions that already exist in the code, plus one new relationship for "refined."

## Identity is the same gap, not a parallel track

An event log is only worth what its actor field can be trusted to mean. Today that field would say "whoever held the shared token" — not meaningfully different from having no actor field at all. This matters more here than it did for the approval-workflow discussion: a compounding record — one designed to accumulate precedent and eventually inform future automated verdicts — is actively misleading if none of its entries can be attributed to a real person. Identity isn't step two after the log exists; every event in the schema should require a verified individual actor from the start.

## Proposed sequence

1. **Foundation — durable event log + real per-developer identity.** Landed together, not staggered — the log is only as trustworthy as the identity behind it. Current-state stores become projections rebuilt from this log at boot.
2. **Modeling — "refined" as a first-class relationship.** Thread same-session replans as a chain rather than unrelated rows — the cheapest correct version, given `sessionId` is already tracked everywhere it would need to be.
3. **Interface — thin review/approval UI over the log.** Cheap once (1) and (2) exist — close to CRUD over data that's now durable and attributable. This is the UI originally proposed, correctly reordered to depend on the record existing first.
4. **Payoff — oracle behavior.** Future gate checks cite past resolutions as precedent. This is the actual "compounding" value — everything before it is prerequisite, not the destination.
5. **Separate track — anchored commenting on stored plan artifacts.** PR-review-style threads on a static snapshot, not live-collaborative editing — the usage pattern is propose-once/review-once. Blocked on deciding full-plan-text retention, which isn't captured today (only a truncated excerpt exists, and only for one registration path).

Git-level revert visibility sits outside every phase above — it needs a new input source (a post-merge hook or CI callback), not a state-model change, and isn't scoped here.

## Also evaluated, deliberately not next

- **Gate-decision log as "phase 1 of a UI project."** Same artifact as phase 1 above, but the original framing made it sound like a UI prerequisite rather than the foundation the whole thesis depends on regardless of any UI. Reordered, not dropped.
- **Google-Docs-style live collaborative commenting.** Implies concurrent live editing for a document that's actually a static, one-shot snapshot. The PR-review pattern (anchored threads on an immutable artifact) matches how designs are actually proposed and reviewed — once, not iteratively co-edited.

## Recommendation

Start with phase 1. It's a smaller engineering lift than it sounds — an append-only log plus projections, in the same "no DB, JSON snapshot" style this codebase already uses — but it's the one piece everything else, including the UI originally requested, is contingent on. Auth hardening (already flagged separately) stops being a someday item at this point: it's load-bearing for the event schema itself, so fold it into phase 1 rather than sequencing it after.

One licensing note worth flagging early rather than late: `packages/server` is AGPL by deliberate choice. If any of this — especially phase 3's UI — ends up shipped as a separately hosted product surface, that's a conscious licensing call to make now, not something to discover after the fact.

---
*Refs: design doc §16 (durability posture), §17 (design-conflict gate) · packages/server/src/design-store.ts, app.ts, hook/design_gate.go*
