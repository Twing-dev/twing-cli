# Orchestrator + Verification Layer — Design Doc

### `twing review-design` / `twing review-code` — v1, August 2026 — implementation handoff

**Scope.** This implements Point 1 (task-time coordination, "the orchestrator") and the
design-check plus test-delta portions of Point 2 (change-time evidence, "the
verification layer") from *The Judgment Layer* (`verification-layer-strategy-memo_6.md`,
v0.4), delivered as two on-request commands: `twing review-design` and
`twing review-code`. **Point 3 (production-time memory) is not covered by this doc** —
no rework mining, no incident learning, no LLM input-coverage tracking; that's a separate
design pass. Capture stays automatic and hook-driven; *review* is something a developer
or agent invokes deliberately — see memo §0 item 3 for why that split exists and what it
replaced.

**Explicit non-goals for v0.** Opposite-direction design detection (row 4 of the
divergence table in §7); embedding/similarity-based duplicate detection; a blocking CI
gate; multi-tenant self-serve signup. All are named again where relevant so nobody
accidentally builds toward them.

**This doc is written to be implemented from directly.** Concrete schemas, protocols,
file layout, and an ordered build sequence are below. Where a detail depends on Claude
Code's hook contract, it's sourced from `code.claude.com/docs/en/hooks` as of this
writing — confirm against current docs before implementing, hook schemas evolve.

---

## 1. Command surface

| Command | What it does | Who/what runs it | Needs daemon? | Needs network? |
|---|---|---|---|---|
| `twing init [--token <token>] [--server <url>]` | One-shot onboarding: merges hook entries into `.claude/settings.json`, ensures the `twing-hook` binary is installed, stores credentials, and starts the daemon as a persistent background service. See §6. | Developer, once per machine (not per clone — see §6) | Starts it | Yes, unless self-hosted with no auth |
| `twing review-design [--intent "..."]` | Design/coordination check: constraint and trigger matches, cross-session divergence. | Developer or agent, on request, any time | Optional — richer if running | Yes |
| `twing review-code` | Everything `review-design` does, plus test-delta integrity analysis over the diff. Run after code exists. | Developer or agent, on request, typically pre-commit | Optional | Yes |
| `twing daemon` | Long-running local process, started by `init`. Rarely invoked directly. | Auto (started by `init`) | — | Yes (async) |
| `twing login [--token <token>]` | Convenience command: rotate credentials or switch servers without a full re-init. Not part of the required onboarding path. | Developer, occasionally | No | Yes |
| `twing-hook <event>` | Not a human-facing command, and not a process that "starts" — spawned fresh per event by Claude Code, exits immediately. `init` only ensures the binary is present. | Claude Code | Yes (fails silently if absent) | No |

`review-design` and `review-code` work with **zero daemon and zero hooks installed** —
they fall back to computing claims from the current git diff directly (§6). The daemon
and hooks are a strict enhancement (continuous ambient capture, proactive nudges), never
a hard dependency. This is deliberate: every piece must be useful standing alone.

---

## 2. System components

| Component | Language | Runs where | Lifetime | Talks to |
|---|---|---|---|---|
| `twing-hook` | Go | Dev machine, spawned per hook event | Milliseconds | `twing daemon` (Unix socket) only |
| `twing daemon` | TypeScript (Node) | Dev machine, one per user | Long-running | `twing-hook` (socket), `twing serve` (HTTPS), local filesystem |
| `twing` CLI | TypeScript (Node) | Dev machine, invoked on request | Seconds | `twing daemon` (optional), `twing serve` (HTTPS), local filesystem/git |
| `twing serve` | TypeScript (Hono) | Hosted VM | Long-running | Postgres, all of the above over HTTPS |

Rationale for the language split is covered in prior discussion — recapped in §14 for
whoever implements this without that context.

---

## 3. Repository layout

```
twing-cli/
  packages/
    core/            # shared: Claim/CallEdge/Notice types, symbol-id algorithm,
                      # Tree-sitter wrapper, wire-message schemas, manifest parser
    cli/              # `twing` — init, login, review-design, review-code
    daemon/           # `twing daemon`
    server/           # `twing serve` — Hono app
  hook/                # Go module — `twing-hook`
    main.go
    go.mod
  .twing/
    verify.yml         # this repo's own manifest (dogfood target)
  docs/
    verification-layer-strategy-memo_6.md
    orchestrator-and-verification-design-doc_v1.md
```

`packages/*` as npm workspaces, matching the layout already used in `twing-dev/TwingMail`.

---

## 4. `twing-hook` (Go) — the capture edge

**Job, precisely:** two operations, both against the local daemon over a Unix socket.
Nothing else. No Tree-sitter, no HTTP, no decision logic.

| Event | Operation | Behavior |
|---|---|---|
| `PostToolUse` (`Edit`\|`Write`) | **Enqueue** | Write one frame to the socket, don't wait for a reply beyond the OS write ack, exit 0 |
| `PostToolUse` (`Read`\|`Grep`\|`Glob`) | **Enqueue** (soft claim) | Same, tagged `stage: soft` |
| `SessionStart`, `UserPromptSubmit` | **Cache-check** | Ask the daemon "anything cached for me?", print its answer, exit 0 |
| Everything else | No-op | Exit 0 immediately |

**Invocation contract** (per `.claude/settings.json`, confirmed against
`code.claude.com/docs/en/hooks`): JSON on stdin, common fields on every event —
`session_id`, `transcript_path`, `cwd`, `hook_event_name`. Tool events additionally carry
`tool_name`, `tool_input`, and on `PostToolUse`, `tool_response`.

**Enqueue message** (hook → daemon, over the socket):

```json
{
  "type": "enqueue",
  "sessionId": "abc123",
  "cwd": "/home/dev/repo",
  "toolName": "Edit",
  "toolInput": { "file_path": "...", "old_string": "...", "new_string": "..." }
}
```

The hook client does **not** parse `toolInput` — it forwards the raw fields verbatim and
lets the daemon (which owns Tree-sitter) do the work. This keeps the Go binary trivial
and keeps parsing logic in one place.

**Cache-check response** (daemon → hook, then hook → Claude Code): the hook wraps
whatever the daemon returns into the exact output shape Claude Code expects. Confirmed
schema:

```json
// SessionStart
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "twing: session on branch payments-retry touched RetryPolicy.backoff 20m ago. Run `twing review-design` before extending it."
  }
}

// UserPromptSubmit — same shape, never sets "decision": "block"
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "..."
  }
}
```

If there's nothing cached, output nothing (empty stdout, still exit 0) — Claude Code
only parses stdout JSON on exit 0, so an empty body with exit 0 is a clean no-op.

**Hard rules:**
- Always exit 0. Socket missing, daemon down, socket write timeout (>50ms) → exit 0,
  empty stdout, silently. Never use exit code 2 (blocking) for anything — that's a
  deliberate policy choice (§4 of the memo: advisory only, never block), not an
  oversight to fix later.
- Never touch `PreToolUse`. It's the one event that *can* deny a tool call, and using it
  for coordination is explicitly out of scope.
- Single static binary, no dependencies, no config file reads beyond the socket path
  (`~/.twing/daemon.sock`, or `$TWING_SOCK` if set — useful for tests).

**Build:** `go build`, cross-compiled per platform via `GOOS`/`GOARCH`. `twing init`
installs the appropriate prebuilt binary (or builds from source if Go is available) and
writes the hook entries pointing at its path.

---

## 5. `twing daemon` (TypeScript) — local capture and cache

**Responsibilities:**
1. Listen on `~/.twing/daemon.sock` for hook-client connections.
2. Process enqueued messages asynchronously — never block the socket accept loop on
   parsing.
3. Extract claims: parse the affected file with Tree-sitter, diff old vs. new to find
   which symbol(s) changed, compute `path::symbol` (§11).
4. Maintain a local call graph for each repo it's seen (§11), updated incrementally.
5. Evaluate the claim against `.twing/verify.yml` locally — constraint hits and trigger
   matches (§10, §12) — entirely on-machine, no network needed for this step.
6. Batch and push claims to `twing serve` on a short debounce (every 5–10s of activity,
   not per-edit) — this is the fire-and-forget async part; nothing waits on it.
7. Poll `twing serve` for notices relevant to this developer and cache them locally, so
   the next `SessionStart`/`UserPromptSubmit` cache-check is an instant local read, never
   a live server round-trip.
8. Persist state to `~/.twing/state.json` periodically, so a daemon restart doesn't lose
   the session's claim history mid-session.

**Socket protocol** (length-prefixed JSON frames over the Unix socket):

| Message | Direction | Payload |
|---|---|---|
| `enqueue` | hook → daemon | See §4 |
| `ack` | daemon → hook | `{ "type": "ack" }` — daemon accepts and returns immediately, processing happens after |
| `get_notices` | hook → daemon | `{ "type": "get_notices", "sessionId": "..." }` |
| `notices` | daemon → hook | `{ "type": "notices", "items": [{ "message": "..." }] }` — pulled straight from the daemon's local cache, zero computation at request time |

**Claim extraction pipeline** (triggered by an `enqueue` message):
1. Read the current file content (post-edit) from disk.
2. Parse with Tree-sitter (v0: TypeScript/JavaScript grammar only — see §15 on why).
3. Locate the enclosing named node (function, method, class) containing the edited
   range → this is the symbol.
4. Compute `symbolId` (§11).
5. If `toolName` is `Edit`/`Write`: also parse the pre-edit version (apply the diff in
   reverse, or use the daemon's last-known parse of this file) and diff the symbol's
   signature. Record `signatureChanged: boolean` and, if true, `oldSignature`/
   `newSignature`.
6. Update the local call graph: re-run a call-expression query over the changed file,
   resolve call targets to `symbolId`s within the repo, diff against the previously
   known edges for this file.
7. Evaluate `.twing/verify.yml` (§10) against this `symbolId`/path → `constraintIds`,
   and against new-symbol patterns → `triggerMatches`.
8. Write the resulting `Claim` (§11) to the local claim store, queued for the next sync.

**Lifecycle:** started by `twing init` (§6), not left to happen lazily. `init` installs a
persistent OS-level service where the platform supports it (a systemd `--user` unit on
Linux, a launchd agent on macOS) so the daemon survives logout and reboot without anyone
thinking about it again — this is the primary path, because a daemon that only runs until
the next reboot defeats the point of "no setup ceremony" from §8.

`twing-hook` still retains a **lazy-start fallback**: if the socket doesn't exist when a
hook fires (service crashed, machine just woke from sleep before the service manager
caught up, developer manually stopped it), the hook spawns the daemon detached and moves
on without waiting for it to be ready. This is a safety net, not the primary mechanism —
the two aren't in tension; eager start-at-init makes the fallback rare, and the fallback
makes eager start non-load-bearing. First few events after any restart may simply find no
daemon and no-op, which is fine and matches the "worst case is a missed hint" tolerance
from the memo. `twing daemon stop`/`start` for manual control during development.

---

## 6. `twing` CLI (TypeScript) — on-request commands

### `twing init`

The single onboarding step. Runs once per machine (hooks are written per-repo the first
time `init` runs there, but the daemon and credentials are machine-wide, so re-running
`init` in a second repo on the same machine just adds hook entries and reuses the
already-running daemon):

1. **Credentials.** `--token`, or the `TWING_TOKEN` env var, or an interactive prompt —
   *unless* `--server` resolves to `localhost`/self-hosted with no auth configured, in
   which case this step is skipped entirely. This is the same flag a future paid/hosted
   tier gates on; for v0/self-hosted it's optional, not absent from the interface.
   Stores `{ token, serverUrl }` in `~/.twing/credentials` (0600 permissions).
2. **Install `twing-hook`.** Ensure the Go binary is present — fetch a prebuilt release
   for the platform, or build from source if a Go toolchain is available. This is a
   preflight install step, not starting a process: `twing-hook` has no lifecycle of its
   own (§4) — nothing runs continuously here.
3. **Wire hooks.** Merge entries into `.claude/settings.json` — must merge into the
   existing `hooks` object, never overwrite the file, since another tool (Entire, or
   anything else) may have already written entries there. Concretely: read the file if
   it exists, parse JSON, `hooks[eventName] = [...(hooks[eventName] ?? []), ourMatcher]`,
   write back.
4. **Start the daemon.** See §5 — installed as a persistent service where possible, a
   detached background process otherwise. Once running, it immediately begins syncing
   with `twing serve` using the credentials from step 1 — there's no separate step where
   capture happens locally-only before "going live"; since `review-design` needs the
   server anyway, there's nothing to gain by delaying that connection.

No `.twing/config.yml` or project-registration step — see §8 for why none is needed.

### `twing login`

Retained only as a convenience for rotating a token or switching servers without
repeating the whole `init` sequence: `twing login --token <token>`. Updates
`~/.twing/credentials` and nudges the running daemon to reconnect with the new
credentials. Not required before `init` works, and not part of the onboarding path.

### `twing review-design [--intent "..."]`

1. **Gather current claims.** If the daemon is running and has data for this
   repo/session, ask it for the live claim set (richer — reflects everything touched
   this session, including files since reverted). Otherwise, fall back to computing
   claims directly: `git diff` against the branch's merge-base with the default branch,
   parsed the same way the daemon would (§5 steps 2–7), run synchronously in the CLI
   process. This fallback is what makes the command work with no daemon and no hooks
   installed at all.
2. **Local checks** — no network yet. Evaluate the gathered claims' `constraintIds` and
   `triggerMatches` against `.twing/verify.yml` directly (§10, §12).
3. **Server round-trip.** `POST /v1/claims` (§9) with the gathered claims and any new
   call-graph edges. The server upserts them and returns divergence findings involving
   *this developer's* claims (textual overlap, contract divergence, trigger-duplication
   — §12).
4. **Print a combined, ranked report** — local constraint/trigger hits first (cheapest,
   most certain), then server-side divergence findings, each with the symbol, the other
   party involved (if any), and why it was flagged.

`--intent` is optional, low-confidence, narration-only input (memo §4's Stage 1) — used
only to narrow which trigger rules get surfaced when there's not yet a diff to inspect
(e.g., run before writing any code). It is never treated as evidence and never
suppresses a finding the diff-based checks would otherwise surface.

### `twing review-code`

Runs everything `review-design` does, then adds:

5. **Test-delta integrity** (§13), entirely local, over the same diff.
6. Merges both result sets into one ranked human-review surface and emits the evidence
   record (§13).

---

## 7. `twing serve` (TypeScript/Hono) — coordination server

### API

| Endpoint | Called by | Does |
|---|---|---|
| `POST /v1/claims` | daemon (periodic background sync) and CLI (`review-design`/`review-code`, synchronous) | Upserts claims + call-graph edges for `projectId`/`developerId`. Runs the divergence checks (§12) against everything currently active in the project. Returns findings involving the just-submitted claims in the response body. |
| `GET /v1/notices?developerId=&since=` | daemon (poll, every few seconds) | Returns findings generated *after* the daemon's last push, including ones triggered by another developer's later activity. This is how developer A learns about a conflict that only became visible when developer B pushed later. |
| Auth admin (v0: direct DB insert or a small local script, not a public endpoint) | operator | Issues a token per developer |

One endpoint (`/v1/claims`) serves both the daemon's silent background sync and the
CLI's on-request review — same upsert-and-compute logic either way. The difference is
purely in how the caller uses the response: the daemon caches it for the next
cache-check; the CLI prints it directly.

### Data model (Postgres via Drizzle, matching TwingMail's setup)

```
developers        (id, name, token_hash, created_at)
claims            (id, project_id, developer_id, session_id, branch, symbol_id, kind,
                    stage, signature_changed, old_signature, new_signature,
                    trigger_matches text[], constraint_ids text[], created_at, expires_at)
call_edges        (project_id, caller_symbol_id, callee_symbol_id)
notices           (id, developer_id, session_id, kind, message, related_symbol_id,
                    other_developer_id, created_at, delivered boolean)
```

`claims.expires_at`: session-scoped lifetime per the memo's active-claims table — set on
insert (e.g., now + 6h), refreshed on any new activity for the same `session_id`. Expired
claims are excluded from divergence queries, not necessarily deleted immediately (cheap
to garbage-collect on a slower cycle).

No `projects` table is strictly required — `project_id` is just a column value derived
client-side (§8); a table is only useful later if you want per-project settings. Skip it
for v0.

### Auth

Bearer token in `Authorization` header, checked against `token_hash` in `developers`.
Store a hash, not the raw token — instant revocation by deleting/rotating the row,
same reasoning TwingMail's CLAUDE.md gives for choosing sessions over JWTs.

---

## 8. Project identity and connecting developers

This is the part that has to work with **zero setup ceremony** for it to be adopted at
all, so it's designed to require none:

> **`projectId = sha256(git remote get-url origin)`.**

Computed identically, independently, by every developer's CLI/daemon the moment they run
any `twing` command inside the repo. No registration step, no "first developer creates
the project," no file to commit and keep in sync. Two developers who clone the same repo
arrive at the same `projectId` without ever coordinating about it, because they're
hashing the same remote URL.

The server does not need a project to be explicitly created — the first `POST /v1/claims`
for a new `projectId` simply starts populating rows tagged with it. There is no
`.twing/config.yml`. The only committed, human-facing file is `.twing/verify.yml` (§10),
which was already going to exist and needs no project-identity fields.

**Edge case:** a repo with no remote (fully local, never pushed) can't be meaningfully
shared between developers anyway — there's no way to clone it. Fall back to a random ID
written to `.git/twing-project-id` (gitignored) so single-developer use still works; this
case has no cross-developer coordination need by construction.

**Connecting a new developer, end to end:**
1. Clone the repo. `.twing/verify.yml` comes along with it if the team has one.
2. `twing init --token <token>` — token issued out-of-band by whoever runs `twing serve`
   (v0: a teammate, an admin script; not a public signup flow). One command: credentials
   stored, hooks wired, daemon started and already syncing (§6).
3. Done. The next `PostToolUse` (hooks are already wired) or the next `twing review-design`
   computes `projectId` from the same remote URL every other developer on this repo is
   using, and immediately participates in the same claim graph.

**Scoping:** every claim, edge, and notice carries `{ projectId, developerId, sessionId,
branch }`. The server's divergence queries always filter by `projectId` first — a
developer on one repo never sees claims from an unrelated one, and the `developerId` on
a token can be reused across repos without any cross-project leakage.

### Sessions vs. machines — what needs to be distinguished, and by what

The server never needs to know which physical machine a claim came from, and doesn't
track it anywhere in the schema (§7). Its divergence checks (§12) key off exactly two
identifiers, both already on every claim: `sessionId` (Claude Code's own globally-unique
session identifier — present in every hook payload, confirmed against the hooks
reference) and `developerId` (from the auth token). Two sessions either conflict or don't
based on what symbols they touch; whether they happen to share a laptop is irrelevant to
whether the divergence is real. A developer running two Claude Code sessions in two
terminal tabs against two worktrees of the same repo is exactly as capable of a genuine
contract-divergence conflict *with themselves* as two different developers are with each
other — and the server catches it for free, because nothing in the check conditions on
machine identity in the first place.

What *does* need machine-local handling is the daemon multiplexing several concurrent
sessions on one machine — including sessions in different repos at once (two terminal
tabs, two projects). A single `twing daemon` process serves every session on that
machine. It keys its local claim store by `sessionId`, supplied in every hook payload
including the enqueue message (§4), and derives `projectId` per-claim from that same
event's `cwd`. One daemon, many sessions, many repos, disambiguated entirely by data
already flowing through the socket protocol — no machine identifier is needed anywhere
in the system.

---

## 9. Deployment — how the server is created

Reuse TwingMail's infrastructure pattern directly rather than inventing a new one — same
Caddy + Docker Compose + Postgres shape already proven at `twing-dev/TwingMail`.

**Concrete steps:**
1. **Where it runs:** add a `twing-serve` service to the existing VM's `docker-compose.yml`
   (or a sibling VM if capacity/isolation later requires it — not needed at dogfood
   scale). Add one block to the `Caddyfile`:
   ```
   orchestrator.twing.dev {
       tls internal
       reverse_proxy twing-serve:PORT
   }
   ```
2. **Database:** a separate Postgres database (not schema-shared with TwingMail's
   tables) — either a second DB on the same Postgres instance or its own. Drizzle +
   the same migration-linter discipline TwingMail already enforces (block `DROP COLUMN`
   etc. on live columns).
3. **Service shape:** copy TwingMail's `packages/api` structure — a Hono app,
   `serve({ fetch: app.fetch, port })`, `/health` endpoint, the same structured JSON
   `logger.ts` (copy verbatim, it has no dependencies).
4. **Deploy:** extend the existing `scripts/deploy.sh` blue/green sequence (warm
   container → health check → swap the Caddy-facing alias → drain old) to also build and
   swap `twing-serve`, or clone the script for this service if keeping deploys
   independent is preferred.
5. **Secrets:** `.env` / `.env.example` convention, same as TwingMail. Needed: `DATABASE_URL`,
   nothing else for v0 (no third-party API keys — this service has no outbound
   dependencies).

---

## 10. `.twing/verify.yml`

Committed to the repo. Three sections:

```yaml
require_human_review:
  - path: "src/auth/**"
    reason: "authorisation surface"
  - symbol: "billing::Invoice.finalize"
    reason: "money; see INC-2024-11"

constraints:
  - text: "use the existing retry helper in net/retry.ts; do not add another"
    scope: "src/net/**"

triggers:
  - id: "new-retry-abstraction"
    pattern: "(?i)retry|backoff"
    match: "new-symbol-name"
    reason: "possible duplicate of net/retry.ts — check before building another"
```

- **`require_human_review`** — always flagged in `review-code`'s output, regardless of
  what the automated checks conclude. Path glob or exact symbol.
- **`constraints`** — ratified, durable facts (memo §5's fast-loop output lands here).
  `scope` is a path glob; a claim touching a matching path is flagged with the
  constraint's text.
- **`triggers`** — patterns matched against *new* symbol names/paths. A match produces a
  `triggerMatches` entry (the trigger's `id`, not its pattern text) on the claim, which
  is what the server correlates across developers (§12, check 4) — this is how
  independent duplicate construction gets caught without ever comparing file contents.

Parsed and evaluated entirely locally, by the daemon or the CLI — never uploaded, never
sent to the server. Only the *results* of evaluating it (`constraintIds`,
`triggerMatches`) transit, consistent with the payload boundary below.

---

## 11. Claim data model and symbol IDs

```ts
interface Claim {
  projectId: string;
  developerId: string;
  sessionId: string;
  branch: string;
  symbolId: string;              // "src/net/retry.ts::RetryPolicy.backoff"
  kind: 'read' | 'write';
  stage: 'soft' | 'firm';        // soft: Read/Grep/Glob; firm: Edit/Write
  signatureChanged?: boolean;
  oldSignature?: string;
  newSignature?: string;
  triggerMatches?: string[];     // trigger ids only, never the pattern
  constraintIds?: string[];
  ts: number;
  ttlMs: number;                 // default 6h, refreshed on session activity
}

interface CallEdge {
  projectId: string;
  callerSymbolId: string;
  calleeSymbolId: string;
}
```

**`symbolId` computation:** parse the file with Tree-sitter, walk up from the edited
range to the nearest ancestor node that is a named function/method/class declaration,
build `<path-relative-to-repo-root>::<enclosing-scope-path>` (e.g.
`src/net/retry.ts::RetryPolicy.backoff` for a method, `src/net/retry.ts::createClient`
for a top-level function). This survives line drift by construction — it's derived from
AST structure, never line numbers.

**Payload boundary, restated as a table of exactly what's in `Claim`/`CallEdge`/`Notice`**
— nothing here is file content, a diff hunk, a prompt, or transcript text. Signatures are
type/name-level, not implementation bodies.

---

## 12. Divergence detection — the v0 checks

Split cleanly by where each check runs — this split is what keeps the payload boundary
real rather than aspirational:

| # | Check | Where | Detection |
|---|---|---|---|
| — | Constraint hit | **Local** (daemon/CLI, reads `.twing/verify.yml` directly) | Path/symbol matches a `constraints` entry's scope |
| — | Trigger match | **Local** (same) | New symbol matches a `triggers` pattern → produces a `triggerMatches` id, which *does* transit |
| 1 | Textual overlap | Server | Another active claim (different `developerId`/`sessionId`), same `symbolId`, `kind: write` |
| 2 | Contract divergence | Server | This claim has `signatureChanged: true`; call graph has an edge `caller → thisSymbolId`; the caller symbol has an active claim from a different developer/session within a recent window |
| 4 | Trigger-duplication | Server | Two active claims from different developers share a `triggerMatches` id and neither has a `textual_overlap` finding already (i.e., they're genuinely different symbols, not the same one) |

Row 3 in the memo's original divergence table (opposite-direction design — A centralises
what B decomposes) has no tractable deterministic detection method yet and is explicitly
**out of scope for v0**. Don't build a similarity/embedding path for it without a
separate design pass — the memo's own open question (§13 Q5) on this is still open.

**Server-side pseudocode for check 2, the flagship:**

```
on new claim c where c.signatureChanged:
  callers = call_edges.where(callee_symbol_id = c.symbol_id).select(caller_symbol_id)
  for caller in callers:
    active = claims.where(
      symbol_id = caller,
      project_id = c.project_id,
      developer_id != c.developer_id,
      expires_at > now(),
    )
    if active.any():
      emit finding(kind: 'contract_divergence', symbol: c.symbol_id,
                    caller: caller, otherDeveloper: active[0].developer_id)
```

---

## 13. `twing review-code`: test-delta integrity

Runs entirely locally, over the same diff `review-design` computed (no server call for
this part — it's pure git + AST, matching the original P1/`twingcheck` design, now folded
in as `review-code`'s second stage rather than a separate command).

**Detects, via AST diff of test files in the changeset:**
- Assertions removed or weakened (specific value → truthy → not-null → gone)
- Test cases deleted
- `skip`/`xfail`/`.only` introduced
- Real calls replaced by mocks
- Tolerances/timeouts widened
- Snapshots regenerated wholesale

**Output — combined with `review-design`'s findings into one ranked report and an
evidence record:**

```
change_id
review_design   → constraint hits, trigger-duplication, contract-divergence findings
test_integrity  → assertion deltas, deletions, skips, mock substitutions,
                  tolerance/timeout widening, snapshot regeneration
review_surface  → ranked list: what a human should look at, and why
```

No mutation testing, no coverage instrumentation, no verification-coverage staging
telemetry in this doc — those are memo P2–P4, out of scope here.

---

## 14. Latency and blocking model (recap)

For whoever implements this without the full prior discussion:

| Path | Blocks Claude Code? | Budget | Why |
|---|---|---|---|
| `PostToolUse` enqueue | Waits for subprocess exit (unavoidable — Claude Code mechanic), but not for any real work | Sub-few-ms | Hook only writes to a socket and exits; all parsing happens in the daemon afterward |
| `SessionStart`/`UserPromptSubmit` cache-check | Same | Sub-few-ms | Daemon answers from an already-computed local cache, never live computation |
| `PreToolUse` | N/A — not used | — | Deliberately unused; it's the one event that can deny an action, out of scope by policy |
| `review-design`/`review-code` | N/A — separate process, not a hook | None | Deliberate, on-request invocation; a human or agent is already waiting for it |
| Daemon → server sync | N/A | None | Fully async, debounced, decoupled from any session |

Go for `twing-hook` specifically because it's spawned fresh on every qualifying tool
call, and a JS runtime's cold-start cost (~50ms on this stack, measured) is paid in full
on every invocation with no way to amortize it — unlike the daemon and server, which
boot once and run for hours.

---

## 15. Build sequence

1. **Capture pipe skeleton.** `twing-hook` (Go) ↔ `twing daemon` (TS) over the socket.
   Enqueue and cache-check round-trip working. Claims are just file paths at this stage
   — no Tree-sitter yet. No server. Validates the mechanism end to end.
2. **Real claims.** Tree-sitter integration in the daemon — TypeScript/JavaScript
   grammar only for v0 (this repo's own stack; self-hosting for dogfood requires it,
   other languages are memo §13 Q7, later). `path::symbol` computation, signature
   diffing, local call graph.
3. **`twing serve` skeleton.** Hono + Postgres/Drizzle, `POST /v1/claims`,
   `GET /v1/notices`, bearer auth. Deployed per §9.
4. **Wire it together.** `twing init` (credentials, hooks, daemon start in one step),
   `projectId` derivation, daemon sync (push claims, poll notices), the
   `SessionStart`/`UserPromptSubmit` nudge working end to end through a real Claude Code
   session.
5. **`twing review-design`.** Local constraint/trigger checks + the server round-trip +
   report printing. **This is the dogfood-ready milestone** — it's what produces the
   memo §14 signal (does knowing what another session touched change what you build).
6. **`twing review-code`.** Add the local test-delta AST analysis, merge into the ranked
   review surface and evidence record.

---

## 16. Open questions carried forward

- **Tree-sitter binding choice** (`node-tree-sitter` native vs. `web-tree-sitter` WASM)
  — native is faster, WASM is simpler to distribute across developer machines/OSes for a
  small team. Pick at implementation time; not load-bearing for the design.
- **Opposite-direction design detection** (memo §13 Q5) — no method proposed here,
  deliberately. Needs its own design pass if it's still wanted after v0 ships.
- **Multi-tenant auth beyond admin-issued tokens** — fine for a small dogfooding team;
  revisit before any external team uses this.
- **Trigger precision** (memo §13 Q2) — still the single highest-risk unknown in the
  whole product. `review-design`'s local trigger-matching is deterministic pattern
  matching against a human-authored file, which sidesteps precision risk on the
  detection side, but doesn't resolve whether the *patterns people write* end up firing
  usefully often vs. constantly vs. never. Only real usage will show this.
