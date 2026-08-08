# The Verification Layer

### A strategy memo for team review — v0.3, August 2026

**Status:** Hypothesis under test. Not a committed direction. Circulated for critique.

**Thesis in one line:** software development used to have natural moments where human judgment attached to the work. Agents dissolved all of them at once. Our product re-attaches judgment deliberately — as evidence and triggers rather than as reading.

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

*Engineering constraint:* hooks run in the hot path. Async writes, locally cached claim table, eventual consistency. A coordination layer that makes agents feel slow gets uninstalled regardless of correctness.

### Point 2 — Change time: the evidence gate

*Restores: authorship-as-verification, and a meaningful test oracle.*

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

The primitive is thin. The engineering that isn't: rewind (working-tree snapshots via shadow branches, a documented failure mode), normalisation across seven agents, non-blocking secret redaction. **The $60M is not for the CLI** — it is a free wedge (4.3k stars) that seeds a corpus and puts them in the workflow. Note the exposure: Anthropic could ship checkpoint/rewind natively into Claude Code and take most of it. Our Point 2 has no equivalent dependency on rented land.

**What they have not shipped:** as of June 2026, no platform, no pricing. Git-compatible database, semantic reasoning layer and AI-native UI are promised. Benchmarks self-reported. In June they opened a waitlist preview of a distributed git network — one-step GitHub mirroring, pitched at agent-fleet rate limits. Note the drift: in February Dohmke said they would not necessarily compete with GitHub; the mirror is now "complementary," partly because it enables in-region code residency. **They shipped the bottom layer, not the middle one.**

**They already ship what we counter-position against.** `strategy_options.summarize.enabled` auto-generates AI summaries at commit time — intent, outcome, learnings, friction points, open items — shelled to Claude CLI, non-blocking. That is a narration layer generated from a transcript. Our contrast is no longer hypothetical: **they summarise the session; we record the artifacts.**

**What they do not do:** test-delta integrity, mutation/coverage evidence, human verification capture, risk-tiered gating, incident learning, task-time coordination. Their stated framing is that the reasoning graph is *"the substrate policy engines will query."* They claim the data layer and leave the decision layer open.

**Read:** eight months ahead on a layer we should not contest, absent on the layer that produces a decision. Their advantage is not product — the code is catchable — it is that Dohmke gets a meeting with any CIO on earth. Which is exactly why we should not try to catch it: winning that layer wins nothing.

**Convergence risk (§12):** if the graph becomes genuinely queryable, "which sessions touched this module and which were reverted" is answerable from it — the beginning of our rework mining, on their data. They would need outcome attribution, not in scope today. Protection is the §9 rule holding.

### The AI review bots

CodeRabbit ($40M ARR April 2026, ~700% YoY), Cursor Bugbot (acquired Graphite Dec 2025), Qodo ($70M Series B March 2026), Greptile, Macroscope, Sonar (acquired Gitar May 2026). GitHub rebuilt Copilot review agentic in March 2026. Pricing moving from seats to per-review (~$1–1.50).

**Structural point:** their recall, comment volume, benchmark incentives and false-positive tolerance all resist becoming a gate. This is our counter-position — and per Helmer a counter-position is only real when the incumbent can see the move and still cannot rationally make it. That condition holds.

### Adjacent

- **DryRun Security** — NL code policies on PRs. Closest to our rule layer; no evidence component.
- **Qodo** — markets attribution-based learning. Positioning claimed, delivery unverified.
- **Align** — captures decisions across Slack/GitHub/Jira into a queryable graph, claims cross-team conflict detection. Closest to our design layer; input is human decision-making, not agent tool calls. Evaluate properly.
- **ADR tooling** (Log4Brains, adr-tools, Codex `AGENTS.md` patterns, Equal Experts' metaprompting) — **all automate drafting.** Writing the record was never the bottleneck; **noticing one was needed is.** Detection is unoccupied.
- **`wit`** (MIT) — function-level locking via Tree-sitter, warning agents before they write. **`swarm-protocol`** (MIT) — headless coordination over MCP: claim work, detect conflicts, heartbeat, hand off. Both last committed 2026-03 and appear dormant. Validation of shape, open field: both stopped short of coordination depth.
- **Orchestrators** (Claude Squad, Conductor, Crystal, Vibe Kanban, amux, Sculptor — 9+) — all converge on git worktrees. Every review notes they solve parallel *execution* and leave alignment, conflict resolution and merge decisions to the human.
- **TDAD** (MIT) — pre-change test impact analysis. Complement to mutation scoping.
- **LLM eval/observability** (Langfuse — MIT, 22k stars, acquired by ClickHouse Jan 2026 — Arize Phoenix, LangSmith, Braintrust, Galileo, Opik, Datadog) — dense and consolidating. Phoenix ships HDBSCAN clustering over embeddings ordered by drift; Datadog ships semantic trace clustering; **Braintrust already does eval-gated deployment blocking on PRs** at Perplexity/Airtable/Replit. This is the one area where our gate concept exists in someone else's product.

**Whitespace confirmed:** nothing shipped detects that a change weakened its own test suite. Nothing detects that a design decision is being made. Both are Point 1 and Point 2.

---

## 7. Build order

Sequenced by **adoption friction ascending** and **whitespace first**. Note this does *not* follow the architectural order of §4 — Point 1 is conceptually first and sequences late, for reasons given below.

Every piece must be fully useful standing alone. The way this category dies is shipping step one as "part of a platform" that does not exist yet.

### P0 — Test-Delta Integrity `[git only, zero friction]`

The CI check described in Point 2. Pure whitespace, needs nothing but git, ships in weeks.

**Why first:** it is the cheapest possible test of the entire thesis. If nobody installs a free tool telling them their agents are weakening their tests, the thesis is dead at near-zero cost. Emits evidence record v0.

### P1 — Diff-Scoped Mutation `[CI, low friction]`

Test strength. Also: formalise and publish evidence record schema v1, including the ratified-constraint output type and the non-change-anchored observation. **Both are free now and painful to retrofit.**

### P2 — Codebase Risk Map `[git + CI, low friction]`

Rework mining as a standalone read-only artifact — *here is where your codebase breaks, derived from your own history*. Strong demo, strong lead-gen, and it solves guardrail cold start: teams never author policies, but they will approve policies proposed from their own history.

**Cold-start unlock available because we are open source:** the *framework-general* layer of failure memory (ORM N+1 patterns, cascade-delete traps) can be mined from public repos and shipped pre-trained in the free tier, no customer data-sharing conversation. Only the *codebase-specific* layer needs their history.

### P3 — Verification Coverage `[staging instrumentation, real deployment ask]`

**Our positional moat.** It requires being present at the moment of verification; Entire reads git history after the fact and structurally cannot get there.

Screen-level observation (for frontend/mobile/CLI work that never touches a server) is a **frontier feature, deliberately deferred** — "my employer's AI watches me work" is a trust problem in most orgs and a legal one in parts of Europe. Ship the server-side version first so the invasive version stays optional rather than load-bearing.

### P4 — The Gate `[policy engine]`

Risk tiers and the NL rule compiler. **Build for two evaluation sites from the start** — this is what makes P5 tractable.

### P5 — Task-Time Coordination and Design Review `[MCP + hooks]`

Point 1, shipped last despite being conceptually first. Three reasons, all about adoption rather than value:

1. **Cold start is worst here.** A registry with one participant does nothing. The gate helps a solo developer on day one; this needs 3+ concurrent agents, and the practical ceiling today is 3–6 before humans lose track.
2. **Different adoption unit.** The gate is per-repo, installed once, org-level. This is per-developer-machine plus MCP client plus hooks plus orchestrator wiring.
3. **Selling ahead of the pain.** Only 0.5% of co-active PR pairs were cross-agent, in 122 of 2,807 repos. The 41.7% figure attaches to a currently rare situation. It will not stay rare, but it is not today's budget line.

**Scope boundary — enforce this.** Build: claim registry, call-graph conflict query, trigger evaluation, constraint store. Do not build: task assignment, scheduling, dashboards, worktree management. "Registry that orchestrators query" is one MCP server; "command centre" becomes Conductor.

### P6 — Input Coverage for LLM Workflows `[expansion]`

Point 3's second half. Deliberately last despite the fastest available flywheel — thousands of daily requests versus sparse code incidents — because entering a dense, funded category with no wedge and no distribution does not get us customers. Flywheel advantage accrues to whoever has them.

Once we are the gate for code changes, "your LLM workflows also have an unverified input surface" is natural land-and-expand inside a buyer who already trusts us. Data handling: embeddings and cluster assignments computed client-side, vectors and metadata only, never raw content.

---

## 8. What we explicitly do not build

- **Provenance / session capture.** Entire owns it, gave it away MIT, and agent vendors are converging on it. Consume, do not compete.
- **Another bug bot.** Sub-50% recall knife fight, consolidating market, benchmark theatre.
- **A git host.** Entire needed $60M for that bet. We consume git.
- **An orchestrator.** Nine-plus OSS options already solve worktree isolation. We own the shared state they read from.
- **Output quality scoring for LLM apps.** Taken, and it forces LLM-as-judge, which breaks §2.

---

## 9. Leverage: what we take for free

**Entire Checkpoints (MIT)** — consume via an **optional adapter** for intent signal. Richer statement of what a change was trying to do when present; fall back to PR description and commit messages when absent.

> **Hard rule: never a required dependency.** Building on Checkpoints makes us a line item on their roadmap the moment their platform ships. Canonical inputs are git, CI, coverage instrumentation, agent tool-call hooks and deploy telemetry — sources nobody owns.

**Tree-sitter** — symbol extraction, multi-language, solved. **MCP** — transport; keeps us agnostic across the eleven-plus orchestrators rather than betting on a winner. **Worktree isolation** — commoditised; reuse wholesale. **`wit` and `swarm-protocol`** — read before designing P5; symbol-level locking is the non-obvious insight and it is already implemented. **TDAD** — complements mutation scoping. **Public repo corpus** — every merged OSS bugfix is a labelled example of *this pattern broke, here is the fix*; available to us because we are open by default.

---

## 10. Business model

**Open core, monetise managed.** Anyone can self-host free.

### Licensing — decide now, hard to reverse

**Not MIT.** Given the asymmetry (Entire $60M/40 people; Cursor owns Graphite; Sonar owns Gitar), permissive licensing means the rational move for any of them is to vendor our engine into an existing distribution channel and out-market us in a quarter. **AGPL or BSL with a clean commercial exception.** Keep "run it yourself free"; lose "a funded competitor ships our engine inside their product."

Settle before the first public commit — contributions cannot be quietly relicensed later.

### Why managed genuinely earns its price

Diff-scoped mutation is compute-heavy and latency-sensitive. Self-hosted it is correct but slow; managed it is fast because we built the mutant scheduling, caching and incremental analysis. Sentry shape, not Redis shape — the paid tier is a real capability gap, not a paywall on features.

### The trade we are accepting

Open source **kills cross-customer learning**. The population that self-hosts is exactly the population that will never share failure data. The failure corpus is per-org.

**But it does not kill network economies entirely.** The P5 claim registry has *intra-org* network effects — value grows with agents connected, each both contributing and consuming — and those are fully compatible with self-hosting because the network lives inside the customer's boundary.

**Why it is still right:** source-code analysis in regulated verticals is the most paranoid buyer segment in enterprise software. *Read the code, run it yourself, audit the gate logic* is a genuine unlock.

**One caveat not to overstate.** Earlier drafts claimed a clean data-residency counter-position against Entire's mirroring. That is weaker than it looked: `--checkpoint-remote` sends checkpoint data to a separate repo with its own token, and Dohmke explicitly pitches in-region hosting. What remains is narrower and honest: **no mirroring at all**, so no sync surface and nothing leaves the customer's infrastructure.

### Beachhead

Regulated verticals — medical devices, critical infrastructure, fintech. The EU AI Act does not classify code-generating agents as high-risk by default, but code generated *for* high-risk systems inherits governance requirements including **how it was generated**, with record-keeping and human-oversight obligations extending into the development process.

That reframes verification evidence from *developer discipline we hope teams maintain* into *an audit artifact with a compliance deadline*. Discipline does not get budget. Compliance artifacts do.

---

## 11. Powers analysis (Helmer)

| Power | Available? | Notes |
|---|---|---|
| Scale economies | No | Per-customer analysis |
| Network economies | **Intra-org only** | Cross-customer forfeited by open source. P5's registry compounds *within* an org — 40 agents wired in do not get casually unwired. Compatible with self-hosting. |
| **Counter-positioning** | **Yes** | Advisory bug-bots cannot become gates without breaking their model. Entire cannot reach task time or staging from git history. |
| **Switching costs** | **Yes** | Accumulated ratified constraints + failure corpus + tuned rules |
| Branding | No | Not at this stage |
| Cornered resource | No | — |
| Process power | Later | The loop, if it works — years 3+, not a wedge |

**Counter-position to enter. Switching costs to hold.**

**Timing:** the category is at origination-into-takeoff. Takeoff is precisely when switching costs get established, and Entire is spending $60M to be the one establishing them. The window is real and not wide.

---

## 12. Relationship to Twing

This is a **parallel hypothesis test, not a pivot.** Twing continues to be sold and supported.

Build costs have collapsed far enough that testing multiple hypotheses in market is cheaper than serially committing to one. P0 in particular is a genuine option — weeks of work, no sales motion — rather than a commitment.

**The honest asymmetry:** this idea has the slowest signal loop and the highest capital requirement of anything we could test, plus a clock on it from a funded competitor. That is precisely the shape that breaks a parallel-hypothesis strategy. **P0 exists to fix that** — it converts the worst-shaped idea in the portfolio into the cheapest test we can run.

---

## 13. Open questions for the team

1. **Precision on test-delta detection.** Refactors, spec changes and flaky-test fixes all resemble weakening. Our false-positive rate determines whether we can ever gate. What is the narrowest high-precision starting set?
2. **Language coverage.** AST analysis and Tree-sitter symbol extraction are both per-language. Which one or two, and what does that imply about beachhead?
3. **Buyer.** Bug bots sell bottoms-up to devs at $24–40/seat. Governance sells to VP Eng / CIO / compliance — longer cycles, higher ACV, and where switching costs accrue. We cannot run both motions. Which?
4. **Placement.** GitHub App (fast distribution, tenant on a platform building into our space) vs. CI-native (more control, worse adoption)?
5. **Does P2's risk map stand alone commercially,** or is it purely a demo asset?
6. **Kill criteria for P0.** What adoption number in what timeframe says this is dead? Agreeing this *before* we build is the whole point.
7. **Is the primitive real** — coverage of the realised space by the verified space — or a retrofitted narrative making four products sound like one platform? It has predicted the gap in four domains before we went looking, which is weak evidence in its favour. If it collapses, §4's structure collapses with it.
8. **Is the ratified constraint a real product surface** or a nice reframe of the gate's output? It now carries §2, §4, §5 and §7. Same test.
9. **Trigger precision (P5).** What firing rate makes design review useful rather than muted? If we cannot specify triggers firing a handful of times per week, the design layer does not work.
10. **Is P5 mis-sequenced?** It contains the fast flywheel and the only network effect, but the worst cold start. Argue for moving it earlier.
11. **Build vs. fork on P5.** `wit` and `swarm-protocol` are dormant but directionally correct.
12. **Does P6 deserve to be last?** It has the densest learning signal of anything here. The memo says distribution beats flywheel. Argue it.

---

## 14. Immediate next step

Ship **P0** as a standalone open-source CI check. Six weeks. No sales motion. No platform narrative.

The signal it produces is the one we need: *does anyone install a free tool that tells them their agents are weakening their test suite?*

- **No** → thesis dead, cost near zero, move to the next hypothesis.
- **Yes** → distribution, a corpus, evidence for the managed pitch, and a beachhead on the one axis Entire is not funded to defend.
