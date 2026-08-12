> **Merged, August 2026.** This spec is implemented as §17 of
> `orchestrator-and-verification-design-doc_v1.md`, with the guardrail reversal it
> requires documented in `verification-layer-strategy-memo_6.md` §4 Point 1. §17 is
> authoritative where the two differ. Concrete deltas: identity fields renamed to this
> repo's existing `projectId`/`developerId`/`sessionId` convention (not `repo_id`/
> `session_id`); Constraint Store persisted as an appended JSON file, not Postgres/
> SQLite; §13's cross-harness adapters (Codex, opencode, Gemini CLI, Pi) deferred,
> Claude Code only; the git-commit-detection close trigger in §8 deferred in favor of a
> `SessionEnd` hook plus the existing TTL fallback. Kept below verbatim as the original
> input document.

# Design Conflict Coordinator — Build Spec (Phase 1 of 3)

Scope: **only** the design-conflict piece of the coordinator (item 1 of the three-part
oracle: design conflicts / merge issues / compound memory). Merge-issue detection and
compound memory are separate builds that reuse this registry but are out of scope here.

## 1. What this system does

An agent (in Claude Code) reaches the point where it has a plan and is about to start
building. Before it's allowed to proceed, its design gets registered with a coordinator
service. The coordinator checks that design against every other currently-open design
(from other agents/sessions working the same repo) and against a store of ratified
canonical abstractions. If there's no meaningful overlap, the agent proceeds immediately.
If there is, the agent is handed the conflicting design and must either adopt it or state
a justified divergence — and a justified divergence is what routes to you as a human.

The goal is not "block conflicts." It's "make divergent decisions visible before they're
concrete," per the earlier framing: minimal conflict is the wrong target, fewer
independent divergent decisions is the right one.

## 2. Components

```
┌─────────────────┐   PreToolUse: ExitPlanMode    ┌──────────────────┐
│  Claude Code     │ ─────────────────────────────▶│  Hook script      │
│  (agent session) │◀───────────────────────────── │  (local, sync)     │
└─────────────────┘   allow / deny / ask           └────────┬─────────┘
                                                              │ HTTPS, blocking
                                                              ▼
                                                    ┌──────────────────┐
                                                    │ Coordinator API   │
                                                    │  - overlap check  │
                                                    │  - constraint chk │
                                                    └────────┬─────────┘
                                                              │
                                              ┌───────────────┴───────────────┐
                                              ▼                               ▼
                                    ┌──────────────────┐          ┌──────────────────┐
                                    │ Design Registry   │          │ Constraint Store  │
                                    │ (open designs)     │          │ (canonical facts) │
                                    └──────────────────┘          └──────────────────┘
```

- **Hook script**: a small local executable (`node`/`python`/`bash`) registered in
  `.claude/settings.json` under `PreToolUse`, matched on `ExitPlanMode` (primary) and
  `Edit|Write` (fallback, see §6). It reads the plan from stdin JSON, calls the
  coordinator, waits, and writes the permission decision to stdout.
- **Coordinator API**: a stateless service (this is the actual product — everything
  else here is scaffolding to get design statements into and out of it).
- **Design Registry**: open design statements, keyed by repo + session, with status and
  a TTL/close mechanism.
- **Constraint Store**: durable, ratified facts — canonical abstractions and domain
  facts — seeded once from the repo and appended to as divergences get resolved.

## 3. Data model

### DesignStatement

```json
{
  "id": "uuid",
  "repo_id": "org/repo",
  "session_id": "claude-code-session-id",
  "agent_label": "optional human-friendly tag, e.g. 'agent-2 / ticket-114'",
  "status": "open | superseded | closed",
  "created_at": "ISO8601",
  "closed_at": "ISO8601 | null",
  "summary": "one-paragraph plain-language description of what's being built",
  "creates": ["new module/interface/symbol names, e.g. 'RetryPolicy class'"],
  "touches": ["file paths / module paths this design will modify"],
  "depends_on": ["existing modules/interfaces/services this design assumes or calls"],
  "raw_plan_excerpt": "verbatim plan text this was extracted from, truncated to ~2k chars"
}
```

`creates` / `touches` / `depends_on` are the structured fields overlap detection runs
against. Free-form `summary` text is a secondary, lower-weight signal — per the earlier
conclusion, free-form prose alone gives fuzzy similarity and false positives, so
structure carries the primary signal.

### Constraint

```json
{
  "id": "uuid",
  "repo_id": "org/repo",
  "type": "canonical_abstraction | domain_fact | review_required",
  "statement": "e.g. 'retries go through pkg/retry, do not build a second retry helper'",
  "scope": ["file/module paths or symbol names this applies to, if applicable"],
  "source": "seeded | ratified_from_divergence:<design_id>",
  "created_at": "ISO8601"
}
```

`review_required` constraints are how (3) — "flag designs that require flagging" —
gets implemented: a global or per-path rule like "anything touching `billing/` needs
human sign-off regardless of overlap" is just a constraint with no overlap logic needed.

## 4. Coordinator API

### `POST /v1/designs/check`

The single call the hook makes. Registers the design AND returns the verdict in one
round trip (no separate register-then-poll — keep the hook's job to one blocking call).

Request:
```json
{
  "repo_id": "org/repo",
  "session_id": "...",
  "agent_label": "...",
  "raw_plan_text": "the full plan text from ExitPlanMode's tool_input.plan"
}
```

The coordinator, not the hook, is responsible for extracting the structured
`DesignStatement` from `raw_plan_text` (see §5) — keeps the hook dumb and the
extraction logic centrally upgradable.

Response, clean case:
```json
{
  "verdict": "clean",
  "design_id": "uuid"
}
```

Response, overlap case:
```json
{
  "verdict": "overlap",
  "design_id": "uuid",
  "conflicts": [
    {
      "conflicting_design_id": "uuid",
      "agent_label": "agent-1 / ticket-108",
      "overlap_kind": "creates | touches | depends_on | constraint",
      "overlap_detail": "both define a RetryPolicy in pkg/retry",
      "conflicting_summary": "one-paragraph summary of the other design",
      "instruction": "adopt_or_justify"
    }
  ]
}
```

Response, constraint-violation case (e.g. duplicate of an existing canonical
abstraction, or a `review_required` path):
```json
{
  "verdict": "constraint_flag",
  "design_id": "uuid",
  "constraint": {
    "statement": "retries go through pkg/retry, do not build a second retry helper",
    "type": "canonical_abstraction"
  }
}
```

### `POST /v1/designs/:id/resolve`

Called after the agent (or a human) resolves an `overlap` or `constraint_flag`
verdict. Body carries one of:
- `{"resolution": "adopted", "adopted_design_id": "..."}` — agent abandons its own
  design and proceeds under the existing one. The agent's own design is marked
  `superseded`.
- `{"resolution": "justified_divergence", "justification": "..."}` — routes to a
  human queue (see §7). Design stays `open` pending human sign-off.

### `PATCH /v1/designs/:id/close`

Marks a design `closed`. See §6 for what triggers this.

### `GET /v1/designs?repo_id=...&status=open`

For visibility / debugging / a future dashboard. Not on the hot path.

## 5. Structured extraction from plan text

`ExitPlanMode`'s `tool_input.plan` is free-form markdown, not structured JSON — you need
a translation step. Cheapest viable version: **one small, cheap-model call inside the
coordinator**, not in the hook, with a fixed extraction prompt:

> Given this implementation plan, extract: (1) new modules, classes, functions, or
> interfaces it creates, (2) existing files/modules it will modify, (3) existing
> modules/services/interfaces it depends on or calls into, (4) a one-paragraph summary.
> Return JSON only, matching this schema: {...}. If a field is empty, return [].

This is a short-input/short-output call (plan text in, ~200 tokens of JSON out) —
exactly the workload the earlier cost analysis was about. Use a fast/cheap model
(Haiku-class); this is not a task that needs a frontier model.

Keep the extraction schema-validated on the way out (reject/retry if the model returns
malformed JSON) since overlap detection in §6 depends on the fields existing.

## 6. Overlap detection (v1 — cheap, not embeddings)

Run in this order, cheapest/highest-precision first:

1. **Exact path/symbol overlap**: intersect `touches` and `creates` arrays (normalized:
   lowercase, strip extensions where relevant) against every other `open` design's
   `touches`/`creates` for the same `repo_id`. Any non-empty intersection = overlap.
2. **Dependency collision**: if design A's `creates` intersects design B's
   `depends_on` (A is building something B already assumes exists, or vice versa),
   flag it — this is the "two agents each build their own retry helper" case even
   when file paths don't literally collide.
3. **Constraint match**: check `creates` and `touches` against the Constraint Store.
   A `canonical_abstraction` constraint whose `scope` intersects `creates` is a
   `constraint_flag`. A `review_required` constraint whose `scope` intersects `touches`
   is also a `constraint_flag`, independent of any agent-vs-agent overlap.
4. **Summary similarity** (secondary, lower confidence): only run if 1–3 found nothing.
   Cheap lexical similarity (e.g. TF-IDF cosine or even Jaccard on keyword sets) between
   `summary` fields, threshold tuned conservatively to avoid false positives — this is
   explicitly a fallback net, not the primary signal, per the earlier "free-form prose
   gives false positives" conclusion. Don't reach for embeddings in v1; the structured
   fields should catch the cases that matter, and false positives here train the person
   to ignore the tool.

This whole check is a handful of set operations plus one cheap-model extraction call —
milliseconds of compute against a design registry that's realistically tens of rows per
repo at a time. No vector DB needed for v1.

## 7. Resolution flow (the "adopt or justify" mechanism)

This is the part that was previously "mechanism TBD" — it's now load-bearing, so it's
specified:

1. Coordinator returns `overlap` or `constraint_flag` to the hook.
2. Hook returns `permissionDecision: "deny"` with `permissionDecisionReason` containing
   the conflicting design's summary and an explicit instruction: adopt the existing
   design, or provide a one-line justification for diverging from it.
   - Must be `deny`, not `ask`: per the hooks reference, `permissionDecisionReason` is
     shown to **Claude** only on `deny` — on `ask` (and `allow`) it's shown to the
     human instead, which pauses the session for a person rather than giving the agent
     anything to act on. `ask` is the wrong primitive for a self-correcting loop; it's
     only appropriate if you deliberately want a human in this specific path.
   - A hard deny with no path forward gets the hook deleted, so the reason text must
     always include a concrete next action (adopt / call the resolve script), not just
     "conflict found."
3. The agent's next action is expected to be either:
   - Revise its plan to reuse the existing abstraction, re-trigger `ExitPlanMode`,
     which re-registers a design that should now come back `clean`, or
   - Call a small companion tool/script that posts to `/v1/designs/:id/resolve` with
     `justified_divergence` and a reason.
4. A `justified_divergence` resolution does **not** unblock the agent by itself in v1 —
   it queues for you. Cheapest viable notification: write to a `pending_review` table
   the coordinator exposes via `GET /v1/reviews?repo_id=...`, and separately push a
   Slack/email notification. The agent's hook, on seeing a still-pending divergence for
   its session, returns `deny` again with "awaiting review, do not proceed" until you
   resolve it via a `POST /v1/reviews/:id/decide {"decision": "approve"|"reject"}` call
   (CLI or a tiny web page — doesn't need to be pretty for v1, it needs to exist).
   (This is the one legitimate case for a human-facing prompt instead — if you want the
   *session itself* to pause and ask a person interactively rather than have the agent
   spin retrying a deny, that's what `ask` is actually for. Worth using here, not in
   step 2.)
5. On `approve`, the divergent design is marked `open` and effectively becomes a second
   valid canonical path (or, if you want stricter behavior, approving a divergence can
   optionally *also* write a new `canonical_abstraction` constraint recording that both
   patterns are acceptable — your call, not required for v1).

This is also, not incidentally, how the Constraint Store gets populated over time beyond
the cold-start seed: every ratified divergence is a new durable fact.

## 8. Design lifecycle — when does a design close?

An open design that never closes is a growing false-positive machine. Two closing
triggers, both needed:

- **Explicit close**: a `PostToolUse` hook matched on `Bash` with a `git commit`
  pattern (or, more robustly, matched on your CI's PR-open step if you have an
  MCP/webhook path into it) calls `PATCH /v1/designs/:id/close`. Ties the design's
  life to the actual commit, which is the real signal that the design became code.
- **TTL fallback**: any design still `open` after N hours (config, start with 24)
  auto-closes to `status: "expired"` rather than `"closed"` — distinguish these in
  the schema so you can tell "this got built" from "this session died / was abandoned"
  when you're debugging why overlap detection missed something.

Session end (`SessionEnd` hook) is a good second trigger for the TTL case — no need to
wait out the full TTL if the session cleanly ended without a commit.

## 9. Hook implementation

`.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "ExitPlanMode",
        "hooks": [{ "type": "command", "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/design-check.sh" }]
      },
      {
        "matcher": "Edit|Write",
        "hooks": [{ "type": "command", "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/design-fallback-check.sh" }]
      }
    ]
  }
}
```

`design-check.sh` (pseudocode, actual impl in Node/Python for JSON handling):

```
read stdin JSON -> extract tool_input.plan, session_id
repo_id = git remote/path, resolved locally
POST {repo_id, session_id, agent_label, raw_plan_text: plan} to coordinator /v1/designs/check
  (blocking, default hook timeout 600s covers the extraction + overlap round trip)
if verdict == clean:
  print {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow"}}
  exit 0
if verdict in [overlap, constraint_flag]:
  print {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "ask",
         "permissionDecisionReason": "<conflicting summary + adopt-or-justify instruction + design_id>"}}
  exit 0
on network/timeout error:
  fail open or closed — this is a real decision, see §10
```

### 9a. The `Edit|Write` gate is the universal path, not just a backstop

This matters more than it looked like at first: `ExitPlanMode` only fires if the agent
enters and exits plan mode. An agent running in default/auto-accept mode, or one that
just skips planning, never produces a `tool_input.plan` — there is no artifact for
`design-check.sh` to extract from. So the `Edit|Write` hook can't just be a "did you
plan?" presence check; it has to be the thing that actually gets a design registered
when no plan text exists at all. Treat `ExitPlanMode` as the fast path (catches the
design before any file touches it, cleanest signal to extract from) and `Edit|Write` as
the path that works unconditionally.

`design-fallback-check.sh`:

```
read stdin JSON -> session_id, tool_input (file_path, and for Write the new content)
GET /v1/designs?session_id=...&status=open
if an open design already exists for this session:
  allow  (already registered, either via ExitPlanMode or a prior resolve call)
else:
  deny with permissionDecisionReason:
    "No design registered for this session. Before editing, call
     `.claude/hooks/register-design.sh` with a summary of what you're building,
     what it creates, what files it touches, and what it depends on. Then retry
     this edit."
  exit 0
```

`register-design.sh` is a small companion script (or, better, an MCP tool the agent
calls directly rather than shelling out — cleaner for the agent to invoke correctly)
that takes structured args and calls `POST /v1/designs/check` with them directly,
bypassing the plan-text-extraction step in §5 entirely since the agent is supplying
the structured fields itself here rather than free prose. This is deliberately a
narrower, more reliable path than plan extraction: the agent is prompted for exactly
the fields overlap detection needs, instead of a model having to infer them from
markdown.

Once `register-design.sh` succeeds, the agent retries its `Edit`/`Write`, the gate
finds an open design for the session, and allows it (subject to §6/§7 same as the
plan-mode path).

**Known residual gap**: this only catches `Edit` and `Write`. An agent that modifies
files through an MCP filesystem tool, or shells out via `Bash` to write files directly
(`cat > file`, `sed -i`, etc.), bypasses this matcher entirely. Add `Bash` to the
matcher list if you want to close that gap, with the hook inspecting the command string
for file-write patterns — lower precision, and explicitly a v1.5 item rather than
blocking on it now. `--dangerously-skip-permissions` does *not* create this gap on its
own (hooks still fire under it); the gap is purely about which tools are matched.

## 10. Fail-open vs fail-closed

Explicit decision needed before shipping: if the coordinator is unreachable or times
out, does the hook `allow` (fail open — coordinator downtime never blocks the agent) or
`ask` (fail closed — coordinator downtime surfaces to the agent/you rather than silently
skipping the check)?

Recommendation: **fail open with a loud local log**, not fail closed. A design-conflict
tool that occasionally blocks all work because its own backend hiccuped will get
disabled fast, and hooks are already bypassable by deleting them — losing coverage
during an outage is a much smaller cost than teaching the team the tool is unreliable
and should be removed. Log every fail-open event locally (`~/.claude/design-coordinator.log`)
so you can audit how often it happens.

## 11. What's explicitly out of scope here

- Cross-language call-graph / symbol-level conflict detection ("Half B" from the
  earlier conversation) — that's the merge-issue piece, separate build, two orders of
  magnitude more surface (tree-sitter adapters, AST-level claims, agent hot path).
- The CI-level backstop that catches a design-shaped diff with no registered design
  at all (agent deleted the hook, or used a client without hook support). Needed
  eventually as the non-bypassable version of §9's fallback; not needed to validate
  the concept with your own usage first.
- Compound memory (the third leg — failure memory / input coverage). Shares the
  Constraint Store's shape conceptually but is a distinct data source (test/prod
  failures, not design statements).

## 12. Suggested build order for Claude Code

1. Coordinator API skeleton + Design Registry (Postgres or even SQLite for v1 —
   this is tens of rows per repo, not a scale problem) with `/v1/designs/check` doing
   only steps 1–3 of §6 (skip similarity fallback initially).
2. Extraction call (§5) wired in, schema-validated.
3. Hook script (§9), tested against a single session first — verify `ask` actually
   surfaces the reason text usefully to the agent.
4. Two-session test: deliberately run two Claude Code sessions on the same repo with
   overlapping plans, confirm the second gets flagged.
5. Resolution flow (§7) — adopt path first (cheaper to verify), then justified-
   divergence + your review endpoint.
6. Lifecycle closing (§8).
7. Cold-start seeding of the Constraint Store from the existing repo (mine current
   canonical abstractions once, manually curate the first pass rather than automating
   extraction from the whole codebase — precision matters more than coverage here).
## 13. Generalizing beyond Claude Code (Codex, opencode, Gemini CLI, Pi)

The coordinator API (§4) is already agent-agnostic — it's a plain HTTP service and
doesn't know or care which harness is calling it. What varies per agent is (a) how
you get a design registered, and (b) how you enforce that registration happened
before any file mutation. Neither needs MCP.

**Why not MCP**: MCP wants the coordinator declared as a server in each agent's config
ahead of time — a capability-at-config-time model. What's actually needed here is
"run this command," which every one of these harnesses already supports natively via
its shell tool, with zero server lifecycle, connection state, or config-time
declaration. Shell access is the one integration surface that's genuinely identical
across all five; MCP client support and configuration is not guaranteed to be, especially
in CI/headless environments. This also keeps the coordinator's whole surface as
"a REST API," reusable by anything, not "a REST API plus an MCP shim."

### 13a. The CLI wrapper

A single script checked into the repo, not installed/published — `.agent-coordinator/
coordinator-cli.sh` (bash + curl; avoid a Node/Python dependency so it works regardless
of which runtime a given harness's sandbox has available). Subcommands:

```
coordinator-cli.sh register   <<< '{"session_id": "...", "raw_plan_text" or structured fields}'
coordinator-cli.sh resolve    <<< '{"design_id": "...", "resolution": "adopted"|"justified_divergence", ...}'
coordinator-cli.sh status     --session <id>      # used by enforcement hooks, not the agent
```

Each subcommand is a thin wrapper over the `/v1/designs/*` endpoints from §4 — same
payloads, same responses, just invoked over stdin/stdout instead of an MCP tool call.
The agent is told to use it via one line in the harness's own instruction file
(`CLAUDE.md` / `AGENTS.md` / `GEMINI.md` / equivalent): "before your first edit, run
`.agent-coordinator/coordinator-cli.sh register` with a summary of what you're
building, what it creates, what it touches, what it depends on."

### 13b. Per-agent enforcement adapters

The registration channel (13a) is identical everywhere. Only the blocking mechanism
differs, and per the survey below, none of the four non-Claude-Code harnesses reliably
support anything richer than deny — so standardize the whole cross-agent protocol on
**deny-only**, including for Claude Code, rather than special-casing `ask`/`defer`
there. One behavior, five adapters.

| Agent | Hook mechanism | Enforcement gate | Notes |
|---|---|---|---|
| Claude Code | `PreToolUse`, JSON stdin/stdout, external script | `Edit`\|`Write` matcher, `deny` + reason | `ExitPlanMode` matcher stays as an earlier, optional catch — not required, since the CLI-based gate covers it either way |
| Codex CLI | `PreToolUse`/`PermissionRequest`, JSON stdin/stdout | match `apply_patch` **and** `Bash` (redundant coverage — docs conflict on whether `apply_patch` reliably aliases Edit/Write) | only `deny` is honored; allow/ask/updatedInput are parsed but ignored |
| opencode | `tool.execute.before`, in-process TS plugin | `input.tool === "edit" \| "write"`, `throw new Error(reason)` to block | synchronous `await` to the coordinator works fine in-process, no subprocess needed |
| Gemini CLI | `BeforeTool`, JSON stdin/stdout or exit code 2 | matcher `write_file`\|`replace` | stderr carries the reason back to the agent |
| Pi | `tool_call` extension hook, in-process TS | match on `toolName` for its write-equivalent tool | no plan mode by default (confirmed — Pi ships without it), so this gate is the *only* mechanism, not a fallback |

Each adapter's logic is the same three lines regardless of language: on a write-shaped
tool call, check `coordinator-cli.sh status --session <id>`; if no open design, block
with a reason telling the agent to register first via the CLI.

**One thing to verify per harness before building, not assumed here**: how each hook
payload identifies "this session" (field name and whether it's stable across the
registration call and the later enforcement call within the same agent run). Confirm
this per adapter — get it wrong and `status` checks will look empty even after a
successful `register` call, which fails closed in the worst possible way (blocks
forever, looks like a coordinator bug).

### 13c. What doesn't change

Everything in §1–§8 and §10–§12 — data model, overlap detection, resolution flow,
fail-open policy, lifecycle closing — is entirely agent-agnostic and unaffected by
this. The only thing that changes across harnesses is the ~50-line adapter that gets
a design registered and gates the first write on it having happened.

