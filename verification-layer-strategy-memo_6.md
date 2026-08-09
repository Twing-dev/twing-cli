# The Judgment Layer

### Coordination at task time · Evidence at change time · Memory from production

**A strategy memo for team review — v0.4, August 2026**

**Status:** Hypothesis under test. Not a committed direction. Circulated for critique.

**Thesis in one line:** software development used to have natural moments where human judgment attached to the work. Agents dissolved all of them at once. Our product re-attaches judgment deliberately — as evidence and triggers rather than as reading.

---

## 0. What changed from v0.3

Four changes, three of them decisions with costs stated below rather than argued away.

**0. The title. "The Verification Layer" named the middle third of the product.**

The memo has always described three layers — coordination before code exists, evidence when it changes, memory from what production does with it (§4). Naming the whole thing after one of them was a live misdirection: it framed us as a CI-time company at exactly the moment we decided coordination ships first. *Judgment* is the through-line the memo already runs on — the five dissolved properties (§1) were all mechanisms by which judgment attached to work, and §4 is literally the three points where it re-attaches. **Verification is one of the three ways judgment re-attaches, not the category.**

**1. We host the orchestrator. "Nothing leaves the customer's infrastructure" is withdrawn.**

v0.3 sold a residency position: no mirroring, no sync surface, nothing off the customer's machines. That position is incompatible with the thing we think is actually defensible. Predicting a merge conflict before it exists, noticing that two sessions are independently building the same abstraction, and noticing that two sessions are moving the same subsystem in *opposite* directions all require one process that can see both sessions at once. A per-machine tool cannot do it. A per-repo CI check cannot do it — by CI time the divergence is already code.

So the coordination layer is a hosted service by default. Self-hosting inside a customer's infrastructure becomes an enterprise deployment option, not the default posture.

The replacement claim is narrower and true: **no code leaves. The claim graph does.** §4a specifies exactly what transits.

**2. Build order inverts. The orchestrator ships first; `twingcheck` second.**

v0.3 sequenced by adoption friction ascending and put task-time coordination last (P5), while §13 Q10 asked whether that was wrong. This draft answers: yes, for a reason v0.3 did not consider — **build leverage**. We are building a multi-developer, multi-agent codebase ourselves. The orchestrator is the tool we need to build everything after it, and we are its first honest user. Nothing else in the plan has that property.

The cost is real and is not being hidden: we lose the cheap kill-test. See §7 and §13 Q6.

**3. Capture stays hook-driven and automatic; the coordination decision itself moved off the hot path, on request.**

§4 Point 1's engineering constraint originally read as: the decision — is this a conflict, does it violate a constraint — has to happen inside the hot hook path, gated at under 30ms. It doesn't, and conflating the two cost real design time before the distinction got made explicit. Claude Code still waits for a hook subprocess to *exit* on every qualifying tool call, so the *handoff* — writing a claim to the local daemon — still has to stay trivially fast; that half of the original constraint is unchanged and still drives the Go/TypeScript language split (§7, P0). But the decision logic, the cross-session comparison, and the report a human actually reads now live behind two on-request commands, `twing align` and `twing review`, invoked deliberately rather than injected synchronously into every turn. The one thing that still rides the hook path is a low-frequency, advisory-only nudge at `SessionStart`/`UserPromptSubmit` — "another session touched X, consider running align" — never a decision, never a block, and cheap because those events fire per-session/per-prompt rather than per-edit. See `orchestrator-and-verification-design-doc_v1.md` for the resulting architecture; it also covers the design-check and test-delta portions of Point 2 under one implementation plan, though Point 3 (production time) is still undesigned.

---

## 1. What actually changed

The industry conversation is "AI writes a lot of code, some of it is bad." That framing produces the wrong product. Here is the more useful one.

Software development had five properties that quietly did the work of quality control. None of them were policies. They were consequences of how code got made:

| Property | What it silently provided |
|---|---|
| Design decisions were slow and discrete — a doc, a meeting, an RFC | A **trigger** for design review |
| The person who wrote the code understood it | Authorship as the **first act of verification** |
| Tests were written by someone who wanted them to mean something | Test suites as a **meaningful oracle** |
| Two engineers rarely edited the same function within the same hour | Concurrency conflicts were **rare and visible** |
| Reading and writing ran at similar speeds | Review was **tractable** |

Agents dissolved all five simultaneously — not by being bad, but by decoupling the speed of production from the speed of judgment.

The consequence is not that AI code is worse. Measured at review time it often looks better. The consequence is that **code now arrives with no judgment attached, and there is no longer a natural moment at which judgment attaches.**

### The evidence

**Volume is past the point of return.** Google reports ~75% of its production code is AI-generated; enterprise averages land near 61%.

**Review-time judgment stopped predicting outcomes.** 78% of technology leaders report *more* production incidents from AI-generated code while most rate it as higher quality at review time. 62% ship without line-by-line verification. Trust has fallen to 29% against 84% adoption.

**The test suite became the target, not the constraint.** Once it is the only oversight left, agents optimise against it. Across measured agent runs: ~30% pass the tests they can see while failing held-out ones, ~8% tamper with the evaluation harness, ~4% edit the success condition itself — and it gets worse as codebases grow. (SpecBench, Verification Horizon, EvilGenie.)

Plainly: **agents routinely weaken tests to go green, and nothing in the commercial stack looks at that.**

**Concurrency conflicts stopped being rare.** 79.4% of agent PRs execute in temporal overlap with another PR. Merge replay across 747 pairs: 19.8% textual conflict same-agent, 41.7% cross-agent. Separately, 27.67% of ~107,000 AI PRs contained conflicts. The researchers' read: agents have *no horizontal awareness whatsoever*.

**Design decisions went invisible.** They are now made continuously, mid-implementation, by an agent, and surface only as code. ADRs are having a revival precisely because agents refactor away reasoning they cannot see — the canonical case being an agent tidying "verbose" retry logic that was written that way after an incident.

### Why the industry's answer is the wrong shape

The response has been to add more reading: AI reviewers that comment on diffs. That compensates for the collapse rather than repairing it, and the numbers show the ceiling. On Macroscope's 118-bug benchmark: CodeRabbit 46%, Bugbot 42%, Greptile 24%, with CodeRabbit averaging ~10.8 comments per PR.

**Sub-50% recall at ten comments per PR cannot be a gate.** It can only advise. And a better summary for a human reviewer — the obvious adjacent idea — merely relocates the problem: it changes the job from "read 2,000 lines" to "trust whoever wrote the summary."

Our claim is that judgment cannot be restored by reading faster. It has to be re-attached at specific moments, as **evidence** (derived, not asserted) and **triggers** (fired, not scheduled).

---

## 2. The core principle

> **Evidence is derived from artifacts, never from narration.**

An agent's session transcript is its *account* of what it did. An agent that weakened a test narrates it as "updated test to reflect new behaviour." Building on transcripts means letting the agent grade its own homework — confidently, fluently, and wrongly.

Everything we assert must be computable from ground truth:

| Claim | Ground truth source |
|---|---|
| What changed in the tests | git diff → AST analysis |
| Whether the tests have teeth | diff-scoped mutation score |
| What the change covers | coverage instrumentation |
| What a human actually exercised | staging path telemetry |
| Who is working where, right now | agent tool calls (Edit/Write) |
| What broke afterwards | deploy attribution + revert/hotfix mining |

### A transcript has no HEAD

There is a second, structural reason transcripts are the wrong substrate, and it worsens with scale.

Git's core property is a pointer to current truth; everything superseded stays reachable but is unambiguously marked history. **A transcript has no such marker.** Considered-and-rejected, tried-and-reverted, correct-at-the-time-now-obsolete, and actually-load-bearing all sit in the same text with equal apparent authority.

So transcript corpora degrade with volume: retrieval cannot distinguish a live decision from an abandoned one. Anyone who has watched a coding agent confidently resurface their own superseded decision has seen this at n=1. Sharing across a team multiplies it by headcount and adds the problem that you cannot tell which of someone else's dead ends were dead.

**Consequence: only ratified facts propagate. Deliberation stays local to the session that produced it.**

This principle now does double duty. It was a claim about evidence quality; with a hosted orchestrator it is also **the data boundary** (§4a). Deliberation staying local is not only epistemically correct, it is what keeps prompts, diffs and transcripts off our infrastructure.

Narration is admitted in exactly one place — as a low-confidence signal at task time (§4), where the worst case is a spurious hint and the gate remains downstream. It is never admitted as evidence that something was verified.

**Corollary for the UI:** human-readable summaries are *rendered from* the structured record, never written alongside it. If a summary can contain a claim the record does not support, we have rebuilt the problem we are selling against.

---

## 3. The primitive

One question runs through everything below:

> **What fraction of the realised space was covered by the verified space?**

It instantiates in four domains, and it has now predicted where the gap lives in each *before* we went looking — which is the main evidence that it is a real generalisation rather than a retrofitted narrative:

| Domain | Verified space | Realised space | The gap |
|---|---|---|---|
| Test strength | Mutants the suite kills | Mutants it could face | Tests that execute code without constraining it |
| Human verification | Paths a test or human exercised | Paths that ship | Code reaching production never once run |
| Concurrency | Each PR against `main` | The merged state | **Nothing verified A+B** |
| LLM workflows | Eval-set input clusters | Production input clusters | Inputs unlike anything verified against |

Everything we build measures one of these gaps and forces a decision about it.

---

## 4. Architecture: three points where judgment re-attaches

The five dissolved properties map onto three moments. This is the organising structure of the product, not three separate products.

### Point 1 — Task time: before the code exists

*Restores: the design-review trigger, and visible concurrency.*

**This is now the first thing we build (§7).**

**Design triggers.** Design and code were never separate *processes* so much as separated by latency. Slow, discrete decisions gave review something to attach to. What broke is not review capacity — **it is the trigger.** Nobody schedules a design review because nobody knows a design decision happened.

Humans define triggers in the same rule language as the gate (*"any new persistence layer"*, *"any new retry/backoff abstraction"*, *"any public API signature change"*). Agents evaluate in-flight work against them. A trip produces review **at the moment of decision**, when the design is five lines of text rather than forty dependent files.

**Coordination claims.** Git implements optimistic concurrency control: assume collisions are rare, detect at merge. Correct when changes were human-paced. Databases established long ago that OCC wins at low conflict rates and pessimistic coordination wins at high ones, and that the crossover is empirical. At 19.8–41.7% with 79.4% temporal overlap, **the crossover has been passed.**

The guardrail: mandatory locking serialises and deadlocks. If the registry makes agents wait, we destroy the parallelism the customer is buying. **Advisory claims only — announce, never block.**

*Granularity.* Git merges on line/hunk adjacency with no semantic understanding. Replicating that buys only earlier delivery of the same signal. The real issue is that **git conflicts on textual adjacency; agents conflict on contract adjacency** — a signature change plus a caller in another file has *zero* textual overlap and guaranteed breakage. Line numbers are also unstable identity.

> **Claim = the symbol. Conflict = the symbol plus its callers and callees.**

Symbol-level via Tree-sitter (`path::symbol`, survives line drift), with conflict resolution as a one-hop call-graph query. This also fixes the hotspot problem: file-level claims on routing tables and config fire constantly; symbol-level claims on the same files rarely collide.

*Progressive confidence.* Claims register continuously, and **response scales with confidence**:

| Stage | Source | Trust | Response |
|---|---|---|---|
| Intent stated | Prompt | Narration | Awareness only |
| Files declared | Agent plan | Prediction | Advisory hint |
| Symbols read | Read/Grep calls | Weak artifact | Soft claim |
| Symbols written | Edit/Write calls | **Artifact** | Firm claim, may escalate |
| Committed | git | Ground truth | Feeds the gate |

This preserves §2. We never *trust* narration, we weight it; only artifact-grade claims may interrupt anyone. Agent hooks fire on tool calls, so claims become artifact-grounded within seconds — the prediction problem shrinks to the first few minutes, when nothing is written anyway.

*Engineering constraint:* hooks run in the hot path — but only the capture handoff does; the coordination decision itself is computed off that path, on request (§0.3). Async writes, locally cached claim table, eventual consistency. A coordination layer that makes agents feel slow gets uninstalled regardless of correctness.

**Three divergence classes, and only one of them is a merge conflict.** This distinction is the case for hosting, so it is worth stating precisely:

| Class | What it looks like | Does git catch it? | Requires cross-session view? |
|---|---|---|---|
| **Textual overlap** | Two sessions edit the same symbol | Yes, at merge | Yes, but low value — git gets there eventually |
| **Contract divergence** | Session A changes a signature; session B writes a caller | **No** — zero textual overlap, guaranteed breakage | **Yes** |
| **Duplicate construction** | Both sessions independently build a retry helper, different shapes | **No** — different files, both merge clean | **Yes** |
| **Opposite-direction design** | A centralises what B is decomposing | **No** — merges clean, leaves an incoherent codebase | **Yes** |

Rows 2–4 are invisible to every tool that inspects one branch at a time, which is every tool in §6. They are visible only to something holding both sessions' claims simultaneously. That is the orchestrator, and it is why the orchestrator is a service rather than a library.

### 4a. What crosses the wire

Since the orchestrator is hosted, this is a load-bearing specification, not an appendix. It should be enforced by the code and documented in the README before the first design partner conversation.

**Leaves the machine:**

| Datum | Form | Why needed |
|---|---|---|
| Session identity | opaque session id, repo id (hashed remote URL), branch, HEAD sha | scope claims to a repo and branch |
| Claims | `path::symbol`, stage, timestamp | the registry |
| Symbol shape | signature only — name, arity, parameter and return types, exported-ness | contract-divergence detection |
| Local call edges | `symbol → symbol` within the repo | the one-hop conflict query |
| Similarity vectors | embedding of signature + docstring, **computed on the developer's machine** | duplicate-construction and opposite-direction detection |
| Trigger matches | rule id + the symbol that tripped it | escalation |
| Ratified constraints | the text a human typed when resolving an escalation | propagation (§5) |

**Never leaves the machine, by default and by construction:**

- File contents, diffs, hunks
- Prompts and agent transcripts (the stage-1 intent signal is matched against rules locally; only the rule id transits)
- Test output, logs, environment, secrets
- Anything produced by `twingcheck`, which runs entirely in the customer's CI

The line to lead with is **"no code leaves"** — not "nothing leaves." It is checkable, it survives a security review, and unlike v0.3's version it is a claim we can actually keep.

**Two consequences to accept openly.** First, this weakens the day-one regulated-vertical beachhead (§10) — a hosted control plane is a longer conversation than a CI check, whatever the payload. Second, symbol names and call graphs are not nothing; a determined adversary learns architecture from them. The honest framing is *metadata-grade, not zero*, and enterprise self-hosting exists for buyers who will not accept metadata either.

### Point 2 — Change time: the evidence gate

*Restores: authorship-as-verification, and a meaningful test oracle.*

Ships as **`twingcheck`** — a standalone check that runs in CI or locally against a diff, with no account and no network (§7 P1).

**Test-delta integrity.** Deterministic AST detection of how the suite changed: assertions removed or weakened (specific value → truthy → not-null → gone), cases deleted, `skip`/`xfail`/`only` introduced, real calls replaced by mocks, tolerances and timeouts widened, snapshots regenerated wholesale. An LLM adjudicates *only already-flagged items* against stated intent.

This inverts the industry pattern — LLM over the whole diff and hope — and it is what makes gating possible at all. **A gate cannot be non-deterministic.**

**Diff-scoped mutation.** Mutation testing has always been correct and operationally dead at repo scale. Scoped to changed lines it is tractable, and it is the only technique that answers *do the tests covering this change have teeth, or do they merely execute it?* Since agents write both the code and its tests, coverage is close to meaningless and mutation is the honest signal. (Research precedent: MuMuTestUp uses surviving mutants as indicators of weak assertions, for repair; we point the same signal at judgment.)

**Verification coverage.** Attestation is worthless here — "I tested it" becomes a checkbox within a quarter, because the discipline required to attest honestly is exactly the discipline that collapsed. So capture, don't ask. Server-side path instrumentation on staging, attributed to a session, produces a number nobody can fake:

> This change touches 14 code paths. Tests exercise 6 (mutation score 0.4). Human interaction exercised 3. **7 paths reach production never having been run by a test or a human.**

**The gate.** Risk tiers from deterministic path rules (`anything under /auth is code-red`) plus natural-language semantic rules (`any change that meaningfully alters authorisation is code-red`). NL rules compile to cached, versioned classifiers with recorded decisions and deterministic replay — structurally a Cedar/OPA policy decision point.

**One rule language, two evaluation sites.** The same compiled rules fire at merge time (blocking, deterministic) and at task time (advisory, Point 1). This is why Point 1 is cheaper than it looks: the classifier work pays for itself twice.

### Point 3 — Production time: what actually broke

*Restores: the institutional memory that used to live in people's heads.*

**Rework mining, not incident mining.** Incidents are far too sparse — perhaps 150 attributable per year at 200 engineers, against the thousands of observations that build a human's prior. The dense signal is already in git and CI: reverted commits, hotfixes within 48h of deploy, PRs needing 3+ rounds, churn-after-merge, CI failures "fixed" by editing the test. That is 10–100× the signal with no new instrumentation. Incidents are the tail; rework is the distribution.

**Input coverage for LLM workflows.** A growing share of production software is itself agentic. It breaks because production sends documents and inputs nobody anticipated, and the disease is strictly worse than for deterministic code: the input space is unbounded, so a curated eval set covers a measure-zero slice. You can have 100% line coverage on a prompt chain and have verified nothing about its behaviour.

Two things make this fit rather than sprawl. First, it is the primitive's fourth instance. Second, it needs a **non-change-anchored** record — these failures often involve no change at all, just a moved input distribution — which is a schema requirement we should absorb now regardless of when we build the product.

The defensible slice is narrow: **eval-set coverage, not drift.** Existing tools say the distribution moved; we would say it moved *relative to what you verified against*, and name the uncovered clusters. Correctness proxies stay artifact-derived — downstream schema violations, retries, output edits, abandonment, escalation to a human. We never claim the output was wrong, only that the input was unlike anything verified against. That keeps us out of LLM-as-judge, which would undercut §2 outright.

### The record that ties them together

One versioned structured object per change, emitting **two** output types:

```
change_id, risk_tier
intent          → stated goal (agent session or PR description)
test_integrity  → assertion deltas, deletions, skips, mock substitutions,
                  tolerance/timeout widening, snapshot regeneration
test_strength   → diff-scoped mutation score, coverage delta
human_evidence  → paths exercised by human traffic pre-merge
gaps            → paths reaching production unexercised by test OR human
history         → prior failure patterns matching this change class
```

1. **A verdict** — auto-merge, escalate, or block. Per-change, expires.
2. **A ratified constraint** — a durable, human-accepted fact about the codebase, produced when a gate escalation or design trigger is resolved by a person. *"Use the existing retry helper; do not add another."*

Verdicts are consumed by CI. **Constraints are the only thing that propagates to other agents.**

If this record becomes the default way anyone represents verification evidence about a change, we own the position regardless of who builds individual checkers — the OpenTelemetry pattern. Own the schema; be the best consumer of it.

---

## 5. The loop, at two speeds

Point 3 feeds Points 1 and 2. Earlier drafts treated this as a single slow flywheel and concluded it could never be demonstrated in a pilot. That was wrong — there are two inputs with very different densities.

| | Slow loop | Fast loop |
|---|---|---|
| Input | Incidents, reverts, hotfixes, rework | Design triggers resolved by a human |
| Density | ~150 attributable incidents/yr at 200 engineers | Several per developer per week |
| Time to value | Quarters | Days |
| Produces | Risk priors, guardrail proposals | Ratified constraints |
| Quality | Inferred from outcomes, statistically noisy | Stated directly by an accountable human |

**The fast loop is the important discovery.** Design review is not just a governance feature — it is the **manufacturing process for ratified constraints**, at the moment they are cheapest to state. A human typing *"use the existing retry helper"* produces a cleaner, more durable constraint than any amount of diff archaeology on a merged PR.

**Discipline, both loops:** every learned pattern must be expressible as a rule that fires or doesn't. If it cannot be, we have not learned it, we have logged it. That is also the only honest flywheel metric — rules derived, fire rate, precision when fired.

### What crosses an accountability boundary

> **Orchestration within an accountability boundary is fine. Context crossing one requires ratification.**

Subagents work today because one accountable human reviews the output. The problem appears when context crosses from one accountable human to another — inheriting decisions nobody signed off on while remaining accountable for the result.

At task start an agent performs two reads with different lifetimes:

| | Ratified constraints | Active claims |
|---|---|---|
| Lifetime | Durable | Session-scoped |
| Source | Gated changes, resolved design triggers | Live tool calls |
| Says | "This is how we do it here" | "Someone is in this symbol now" |
| On conflict | Escalate | Usually self-resolve |

### Escalation discipline

Human attention is the scarce resource this entire product exists to protect, so most divergence must never reach a person. If agent A learns agent B is mid-flight on a retry helper, A can use it, narrow scope, or reorder — agent-to-agent, no interrupt. Escalate only when the divergence crosses a **ratified constraint** or a **code-red surface**. The gate's risk tiers are the filter, pointed upstream.

Design triggers escalate by definition, so this is where the attention tax bites hardest. **Target a handful per team per week.** A trigger firing on 20% of tasks is mis-specified. Ship trigger precision as a first-class metric.

**Do not recreate the RFC process.** ADRs died because they were discretionary documentation work; if design review is a document, it dies the same way. Rule fires, agent states the delta in five lines, human answers in one. Ten minutes and it will not survive a deadline. *ADRs failed because they were discretionary. Triggers make them automatic.*

---

## 6. Competitive position

### Entire (ex-GitHub CEO Thomas Dohmke)

$60M seed at $300M valuation (Felicis, Madrona, M12, Basis Set; Jerry Yang and Garry Tan angel). 40+ people, nine countries. Largest devtools seed on record.

**What they own:** provenance capture. Checkpoints is an MIT-licensed CLI pairing every commit with the session that produced it — transcript, prompts, tool calls, token usage, line-level attribution — on a separate `entire/checkpoints/v1` branch inside the repo. Agent-agnostic. Plus `entire blame` / `entire why`, and Entire Review for multi-agent parallel review.

**How it works** (verified against the repo; this sets the ceiling on what they can claim): `entire enable --agent claude-code` writes hooks into `.claude/settings.json`. Claude Code fires them with JSON on stdin containing session ID and **transcript path**. Entire reads the JSONL the agent already wrote to disk; git hooks anchor it to the commit. Per agent, a different config location and transcript format — hence a separate `external-agents` repo.

The primitive is thin. The engineering that isn't: rewind (working-tree snapshots via shadow branches, a documented failure mode), normalisation across seven agents, non-blocking secret redaction. **The $60M is not for the CLI** — it is a free wedge (4.3k stars) that seeds a corpus and puts them in the workflow. Note the exposure: Anthropic could ship checkpoint/rewind natively into Claude Code and take most of it.

**They already ship what we counter-position against.** `strategy_options.summarize.enabled` auto-generates AI summaries at commit time — intent, outcome, learnings, friction points, open items — shelled to Claude CLI, non-blocking. That is a narration layer generated from a transcript. Our contrast is no longer hypothetical: **they summarise the session; we record the artifacts.**

**What they have not shipped:** as of June 2026, no platform, no pricing. Git-compatible database, semantic reasoning layer and AI-native UI are promised. Benchmarks self-reported. In June they opened a waitlist preview of a distributed git network — one-step GitHub mirroring, pitched at agent-fleet rate limits. **They shipped the bottom layer, not the middle one.**

**What they do not do:** test-delta integrity, mutation/coverage evidence, human verification capture, risk-tiered gating, incident learning, live cross-session coordination.

**Two positions we held in v0.3 and no longer hold.** Both deletions follow from §0, and both should be said out loud rather than quietly dropped:

1. *"We have no sync surface and they do."* Gone. We are now a hosted control plane. What remains is a payload difference — they mirror repositories, we hold a claim graph and no code — which is defensible but is a different, smaller argument.
2. *"They structurally cannot reach task time."* Overstated, and it is now the sharpest risk in the memo because task time is our lead product. **Entire's hooks are already installed in `.claude/settings.json` on every machine that runs Checkpoints.** The distribution is in place. What they lack is artifact-grade claim extraction, a live shared registry, and a reason — their substrate is the transcript and their product is provenance. That is a real gap in *system*, not a moat. If task time is the lead, our protection there is execution speed and the accumulated constraint corpus, not structure. See §13 Q3.

**Read:** eight months ahead on a layer we should not contest, absent on the layer that produces a decision — but no longer structurally excluded from ours. Their durable advantage is that Dohmke gets a meeting with any CIO on earth.

### The AI review bots

CodeRabbit ($40M ARR April 2026, ~700% YoY), Cursor Bugbot (acquired Graphite Dec 2025), Qodo ($70M Series B March 2026), Greptile, Macroscope, Sonar (acquired Gitar May 2026). GitHub rebuilt Copilot review agentic in March 2026. Pricing moving from seats to per-review (~$1–1.50).

**Structural point:** their recall, comment volume, benchmark incentives and false-positive tolerance all resist becoming a gate. This is our counter-position — and per Helmer a counter-position is only real when the incumbent can see the move and still cannot rationally make it. That condition holds. It holds *more strongly* at task time: a per-PR review product cannot see two in-flight sessions at once without becoming a different company.

### Adjacent

- **DryRun Security** — NL code policies on PRs. Closest to our rule layer; no evidence component.
- **Qodo** — markets attribution-based learning. Positioning claimed, delivery unverified.
- **Align** — captures decisions across Slack/GitHub/Jira into a queryable graph, claims cross-team conflict detection. **Now our closest competitor**, since the design layer leads. Their input is human decision-making; ours is agent tool calls. Evaluate properly and early.
- **ADR tooling** (Log4Brains, adr-tools, Codex `AGENTS.md` patterns, Equal Experts' metaprompting) — **all automate drafting.** Writing the record was never the bottleneck; **noticing one was needed is.** Detection is unoccupied.
- **`wit`** (MIT) — function-level locking via Tree-sitter, warning agents before they write. **`swarm-protocol`** (MIT) — headless coordination over MCP: claim work, detect conflicts, heartbeat, hand off. Both last committed 2026-03 and appear dormant. Validation of shape, open field: both stopped short of coordination depth — and specifically, both stop at row 1 of the divergence table in §4. **Read both before writing a line of the orchestrator** (§13 Q11).
- **Orchestrators** (Claude Squad, Conductor, Crystal, Vibe Kanban, amux, Sculptor — 9+) — all converge on git worktrees. Every review notes they solve parallel *execution* and leave alignment, conflict resolution and merge decisions to the human. They are our first integration surface, not our competition.
- **TDAD** (MIT) — pre-change test impact analysis. Complement to mutation scoping.
- **LLM eval/observability** (Langfuse — MIT, 22k stars, acquired by ClickHouse Jan 2026 — Arize Phoenix, LangSmith, Braintrust, Galileo, Opik, Datadog) — dense and consolidating. Phoenix ships HDBSCAN clustering over embeddings ordered by drift; Datadog ships semantic trace clustering; **Braintrust already does eval-gated deployment blocking on PRs** at Perplexity/Airtable/Replit.

**Whitespace confirmed:** nothing shipped detects that two live sessions are diverging on contract, duplicating an abstraction, or moving a subsystem in opposite directions. Nothing shipped detects that a change weakened its own test suite. Those are Point 1 and Point 2, in that order.

---

## 7. Build order

Sequenced by **build leverage first, then adoption friction ascending**. This is the change from v0.3, which sequenced purely on friction.

Every piece must be fully useful standing alone. The way this category dies is shipping step one as "part of a platform" that does not exist yet.

### P0 — The Orchestrator `[hooks + MCP, hosted, dogfooded]`

Point 1: claim registry, symbol-level claims via Tree-sitter, one-hop call-graph conflict query, trigger evaluation, constraint store.

**Why first — three reasons, none of them adoption:**

1. **We are the first user.** We are about to build a multi-developer, multi-agent codebase. Every problem the orchestrator solves is a problem we will have while building `twingcheck`. Nothing else in the plan is dogfoodable on day one, and dogfooding is the only cure for the cold-start objection that sequenced this last in v0.3 — a registry with one participant does nothing, but our registry has participants immediately.
2. **It is the tool the rest is built with.** Trigger precision, constraint quality and escalation rate are unknowable from a whiteboard. We will have hundreds of internal observations before the first customer, and those observations are the design input for the gate.
3. **The rule language gets built at the cheap evaluation site.** Task-time rules are advisory; a false positive costs a hint. The same compiled rules later gate merges, where a false positive costs trust. Building the language against the advisory site first is strictly safer (§4, Point 2).

**Ships in stages, each usable:** capture (observe-only claim log, no coordination) → registry (advisory cross-session hints) → triggers (design escalation, the fast loop starts) → constraints (`.twing/verify.yml`, propagation).

**Scope boundary — enforce this.** Build: claim registry, call-graph conflict query, trigger evaluation, constraint store. Do not build: task assignment, scheduling, dashboards, worktree management. "Registry that orchestrators query" is one MCP server; "command centre" becomes Conductor.

**What we accept by putting this first:** the adoption unit is per-developer-machine plus hooks plus orchestrator wiring, not per-repo; cross-agent co-activity is still rare in the market (0.5% of co-active PR pairs, in 122 of 2,807 repos); and we are selling slightly ahead of the pain. All three of v0.3's objections stand. We are overriding them on build leverage, not refuting them.

### P1 — `twingcheck` — Test-Delta Integrity `[git only, zero friction]`

The CI check described in Point 2, plus the verification manifest. Deterministic AST detection of test weakening, producing a ranked human-review surface. Pure whitespace, needs nothing but git, no account, no network.

**Why second rather than first:** it remains the cheapest test of the thesis and the free OSS wedge, and it is now also the thing P0's constraint output writes into. Shipping it second costs us the early kill-signal (§13 Q6) and buys internal validation of the rule language it depends on.

Emits evidence record v0. Formalise and publish the schema here, including the ratified-constraint output type and the non-change-anchored observation — **both are free now and painful to retrofit.**

### P2 — Diff-Scoped Mutation `[CI, low friction]`

Test strength. Attaches to `twingcheck` as a second evidence source and upgrades the review surface from "this test got weaker" to "these tests never had teeth."

### P3 — Codebase Risk Map `[git + CI, low friction]`

Rework mining as a standalone read-only artifact — *here is where your codebase breaks, derived from your own history*. Strong demo, strong lead-gen, and it solves guardrail cold start: teams never author policies, but they will approve policies proposed from their own history — proposed as lines in `.twing/verify.yml`.

**Cold-start unlock available because we are open source:** the *framework-general* layer of failure memory (ORM N+1 patterns, cascade-delete traps) can be mined from public repos and shipped pre-trained in the free tier. Only the *codebase-specific* layer needs their history.

### P4 — Verification Coverage `[staging instrumentation, real deployment ask]`

**Our positional moat at change time.** It requires being present at the moment of verification; Entire reads git history after the fact and structurally cannot get there.

Screen-level observation (for frontend/mobile/CLI work that never touches a server) is a **frontier feature, deliberately deferred** — "my employer's AI watches me work" is a trust problem in most orgs and a legal one in parts of Europe. Ship the server-side version first so the invasive version stays optional rather than load-bearing.

### P5 — The Gate `[policy engine]`

Risk tiers and the NL rule compiler at the blocking site. By this point the rule language has a year of advisory firing behind it and the manifest is already in customers' repos; this step is formalisation and enforcement, not invention.

### P6 — Input Coverage for LLM Workflows `[expansion]`

Point 3's second half. Deliberately last despite the fastest available flywheel, because entering a dense, funded category with no wedge and no distribution does not get us customers. Once we are the gate for code changes, "your LLM workflows also have an unverified input surface" is natural land-and-expand. Data handling: embeddings and cluster assignments computed client-side, vectors and metadata only, never raw content — the same boundary as §4a.

---

## 8. What we explicitly do not build

- **Provenance / session capture.** Entire owns it, gave it away MIT, and agent vendors are converging on it. Consume, do not compete.
- **Another bug bot.** Sub-50% recall knife fight, consolidating market, benchmark theatre.
- **A git host.** Entire needed $60M for that bet. We consume git. *This constraint gets harder to hold now that we run a service — the pull toward "since we already have the claim graph, let us also hold the branches" is exactly how this becomes a $60M bet we have not raised for.*
- **An orchestrator in the execution sense.** Nine-plus OSS options already solve worktree isolation and task running. We own the shared state they read from. The word "orchestrator" in this memo means the coordination service, never a scheduler.
- **Output quality scoring for LLM apps.** Taken, and it forces LLM-as-judge, which breaks §2.

---

## 9. Leverage: what we take for free

**Entire Checkpoints (MIT)** — consume via an **optional adapter** for intent signal. Richer statement of what a change was trying to do when present; fall back to PR description and commit messages when absent.

> **Hard rule: never a required dependency.** Building on Checkpoints makes us a line item on their roadmap the moment their platform ships. Canonical inputs are git, CI, coverage instrumentation, agent tool-call hooks and deploy telemetry — sources nobody owns.

**Agent hooks** — the capture surface. Every major agent now fires configurable subprocess hooks on tool calls; that is where artifact-grade claims come from, and it is available today without asking any vendor's permission.

**Tree-sitter** — symbol extraction, multi-language, solved. **MCP** — transport; keeps us agnostic across the eleven-plus orchestrators rather than betting on a winner. **Worktree isolation** — commoditised; reuse wholesale. **`wit` and `swarm-protocol`** — read before designing P0; symbol-level locking is the non-obvious insight and it is already implemented. **TDAD** — complements mutation scoping. **Public repo corpus** — every merged OSS bugfix is a labelled example of *this pattern broke, here is the fix*; available to us because we are open by default.

---

## 10. Business model

**Open core, monetise the service.** The clients, the analyzers and `twingcheck` are open and self-hostable. The coordination service is hosted.

This is a cleaner open-core line than v0.3 had. Previously the paid tier was "the same thing, but our mutation scheduler is faster" — a real capability gap, but a soft one. Now the paid tier is a component that is *inherently* multi-tenant and stateful, which is the shape open core actually works in.

### Licensing — decide now, hard to reverse

**Not MIT.** Given the asymmetry (Entire $60M/40 people; Cursor owns Graphite; Sonar owns Gitar), permissive licensing means the rational move for any of them is to vendor our engine into an existing distribution channel and out-market us in a quarter. **AGPL or BSL with a clean commercial exception.** Keep "run it yourself free"; lose "a funded competitor ships our engine inside their product."

AGPL fits the new shape better than it fit the old one: the hosted service is precisely the thing AGPL's network clause covers.

Settle before the first public commit — contributions cannot be quietly relicensed later.

### Deployment tiers

| Tier | Orchestrator | Who it is for |
|---|---|---|
| **Free / OSS** | `twing serve` on localhost or a team VM. Full function, single team, self-operated. | Solo developers, OSS projects, evaluation |
| **Hosted** *(default)* | Ours. Cross-repo, cross-team, managed. | The commercial product |
| **Enterprise self-hosted** | Theirs, in their VPC. Same binary as hosted. | Regulated buyers who will not accept metadata leaving |

Building the localhost path first is not charity — it is how the thing is testable, and it keeps the enterprise self-hosted tier from being a rewrite later.

### The residency position, restated honestly

v0.3 claimed *nothing leaves the customer's infrastructure*. That is withdrawn (§0). The replacement:

> **No code leaves.** Not diffs, not files, not prompts, not transcripts. The claim graph — symbols, signatures, call edges, locally-computed vectors — is what transits, and it transits only for teams who turn coordination on.

Three supports for this being sellable rather than merely honest: the payload is specified and enforceable (§4a); `twingcheck` and everything at change time run entirely in the customer's CI, so the highest-value check requires no connection at all; and the enterprise self-hosted tier exists for buyers who refuse metadata.

**We should also stop implying a residency advantage over Entire.** `--checkpoint-remote` sends checkpoint data to a separate repo with its own token, and Dohmke explicitly pitches in-region hosting. We are now both hosted. The difference is payload, and payload is the argument to make.

### The trade we are accepting

Open source **kills cross-customer learning** for the failure corpus: the population that self-hosts is exactly the population that will never share failure data.

**But it does not kill network economies.** The claim registry has strong *intra-org* network effects — value grows with agents connected, each both contributing and consuming — and hosting means those effects compound across repos and teams inside a customer rather than stopping at one machine. That is a materially stronger position than v0.3's, and it is the direct payoff of the residency decision.

### Beachhead — this moves

v0.3 pinned the beachhead to regulated verticals, on the strength of the residency claim. With that claim withdrawn, regulated verticals become an *expansion* segment reached via the self-hosted tier and the EU AI Act argument below, not the entry point.

The entry point follows the product: **teams already running three or more concurrent agents and already feeling the coordination pain.** That is a smaller market today (0.5% of co-active PR pairs are cross-agent, in 122 of 2,807 repos) and a bottoms-up motion. It is also the only segment for which P0 is obviously worth installing.

The compliance argument survives intact for later: code generated *for* high-risk systems inherits governance requirements including **how it was generated**, with record-keeping and human-oversight obligations extending into the development process. That reframes verification evidence from *developer discipline we hope teams maintain* into *an audit artifact with a compliance deadline*. Discipline does not get budget. Compliance artifacts do. Note that the artifact that argument needs is `twingcheck`'s evidence record and the manifest — both of which run entirely inside the customer's infrastructure.

---

## 11. Powers analysis (Helmer)

| Power | Available? | Notes | Change from v0.3 |
|---|---|---|---|
| Scale economies | Weak | Hosted coordination amortises infrastructure across customers; analysis stays per-customer | ↑ from No |
| **Network economies** | **Intra-org, compounding** | Value grows with agents connected. Hosting extends this across repos and teams inside a customer instead of stopping at one machine. Cross-customer failure learning still forfeited by open source. | ↑ strengthened |
| **Counter-positioning** | **Yes** | Advisory bug-bots cannot become gates without breaking their model, and a per-PR product cannot see two in-flight sessions at once. | = but narrower vs Entire |
| **Switching costs** | **Yes** | Accumulated ratified constraints, tuned triggers, failure corpus. Note the manifest lives in *their* repo — deliberately weakening lock-in in exchange for adoption. | = |
| Branding | No | Not at this stage | = |
| Cornered resource | No | — | = |
| Process power | Later | The loop, if it works — years 3+ | = |

**Counter-position to enter. Network economies and switching costs to hold.**

**Timing:** the category is at origination-into-takeoff. Takeoff is precisely when switching costs get established, and Entire is spending $60M to be the one establishing them. The window is real and not wide. Leading with the orchestrator puts us on the earlier moment in the workflow, where the switching costs actually accrue — and closer to the one competitor with distribution already installed on the same machines.

---

## 12. Relationship to Twing

This is a **parallel hypothesis test, not a pivot.** Twing continues to be sold and supported.

**The v0.3 argument no longer applies unchanged, and this is the most important caveat in the draft.** v0.3's case for testing this hypothesis in parallel rested on P0 being a genuine option — six weeks, no sales motion, cheap to abandon. Leading with the orchestrator gives up that property. The orchestrator is a service, it has state, it has an on-call implication the moment a second team uses it, and it cannot be abandoned as cheaply as a CI check.

Two things make it defensible anyway, and the team should decide whether they are enough:

1. **It is not spend we would otherwise avoid.** We are building a multi-agent codebase regardless. A meaningful fraction of P0 is infrastructure we would want for ourselves even if the commercial hypothesis dies.
2. **The kill-test is delayed, not deleted.** `twingcheck` still ships as a free-standing OSS check with no sales motion, and it still asks its question. It just asks it in month four rather than month one.

**The honest asymmetry remains:** this idea has the slowest signal loop and the highest capital requirement of anything we could test, plus a clock on it from a funded competitor — and the new sequencing makes the first two worse in exchange for build leverage and a working fast loop. That trade should be made explicitly, not absorbed.

---

## 13. Open questions for the team

Reordered; new and materially changed questions marked.

1. **Kill criteria for P0.** *(new — replaces v0.3 Q6 in priority)* We gave up the cheap kill-test. What internal signal, by what date, says the orchestrator is not working? Candidate: *after eight weeks of our own use, are we resolving design triggers at a rate that produces at least one ratified constraint per developer per week, at trigger precision above X?* Agreeing this before we build is now more important than it was, not less.
2. **Trigger precision.** *(promoted)* What firing rate makes design review useful rather than muted? If we cannot specify triggers firing a handful of times per week, the lead product does not work. This is the single highest-risk unknown in the memo now.
3. **Entire at task time.** *(new)* Their hooks are already installed on the same machines. If they ship a claim registry in six months, what do we have that they do not? If the honest answer is "a head start and better claim extraction," is that enough to lead with?
4. **What exactly transits, and who signs off on it.** *(new)* §4a is a specification; it needs a security review and a written data-handling document before the first design partner, not after. Do we also need a "signatures only, no vectors" mode for the paranoid tier?
5. **Duplicate and opposite-direction detection.** *(new)* Contract divergence is deterministic. The other two rows of §4's table are similarity judgments over signatures and docstrings. What is the actual detection method, what is its precision, and does it survive §2 — or are we quietly admitting a semantic judgment into a product that sells determinism?
6. **Precision on test-delta detection.** Refactors, spec changes and flaky-test fixes all resemble weakening. Our false-positive rate determines whether we can ever gate. What is the narrowest high-precision starting set?
7. **Language coverage.** AST analysis and Tree-sitter symbol extraction are both per-language. Which one or two, and what does that imply about beachhead?
8. **Buyer.** *(changed)* The residency decision moves this. Bottoms-up to agent-fleet-running dev teams is the natural P0 motion; governance sells to VP Eng / CIO / compliance and is where switching costs accrue. v0.3 said we cannot run both motions. Does leading with P0 commit us to bottoms-up for two years?
9. **Placement.** GitHub App (fast distribution, tenant on a platform building into our space) vs. CI-native (more control, worse adoption)? Now applies only to `twingcheck`; P0's placement question is which orchestrators we integrate with first.
10. **Does the manifest belong in the repo?** It weakens lock-in on purpose. Is that the right trade, or are we giving away the switching cost we identified as one of only two available powers?
11. **Build vs. fork on P0.** `wit` and `swarm-protocol` are dormant but directionally correct, and both implement the symbol-level claim primitive. More urgent now that P0 leads.
12. **Is the primitive real** — coverage of the realised space by the verified space — or a retrofitted narrative making four products sound like one platform? It has predicted the gap in four domains before we went looking. If it collapses, §4's structure collapses with it.
13. **Is the ratified constraint a real product surface** or a nice reframe of the gate's output? It now carries §2, §4, §5, §7 and the manifest. Same test.
14. **Does P6 deserve to be last?** It has the densest learning signal of anything here. The memo says distribution beats flywheel. Argue it.

---

## 14. Immediate next step

Build **P0 stage one — capture — and run it on ourselves.**

Concretely: hooks into `.claude/settings.json` writing artifact-grade `path::symbol` claims to a local daemon, a `twing serve` registry on a shared host, and advisory cross-session hints delivered back into agent context. Every developer building `twingcheck` runs it from day one.

The signal it produces is one no customer can give us this early: *does knowing what the other sessions are touching change what we build, or is it a notification we learn to ignore?*

- **Ignored** → the design layer does not work, and we fall back to shipping `twingcheck` as the standalone OSS wedge — v0.3's plan, four months late but not dead.
- **Used** → we have a working fast loop, a constraint corpus, an internal precision dataset for triggers, and the tool that makes building everything downstream cheaper.

`twingcheck` follows immediately after, and remains the thing we take to market first.
